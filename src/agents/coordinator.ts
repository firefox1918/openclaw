/**
 * Coordinator Pattern - Claude Code's idle-loop task claiming mechanism.
 *
 * Key innovation: When idle, automatically claim and execute ready tasks.
 *
 * ## Concept (Claude Code 12-Layer Harness S11)
 *
 * Traditional: Wait for explicit task assignment
 * Coordinator: Idle loop → get_ready tasks → claim → execute → report
 *
 * ## Integration Points
 *
 * 1. pi-embedded-runner/run.ts - Idle loop integration
 * 2. Task management system - Task claiming mechanism
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("coordinator");

// ============================================================================
// Types
// ============================================================================

/**
 * Coordinator task interface - minimal representation for coordinator operations.
 */
export interface CoordinatorTask {
  /** Task ID */
  id: string;
  /** Task description */
  subject: string;
  /** Current status */
  status: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  /** Task owner */
  owner?: string;
  /** Task priority */
  priority?: "critical" | "high" | "medium" | "low";
  /** Tasks that block this one */
  blockedBy: string[];
  /** Tasks this one blocks */
  blocks: string[];
}

/**
 * Task store interface for coordinator operations.
 */
export interface CoordinatorTaskStore {
  /** Get a task by ID */
  get(id: string): CoordinatorTask | undefined;
  /** Get all ready tasks (not blocked, not claimed) */
  getReadyTasks(): CoordinatorTask[];
  /** Get all blocked tasks */
  getBlockedTasks(): CoordinatorTask[];
  /** Claim a task */
  claim(
    id: string,
    owner: string,
    sessionKey?: string,
  ): { success: boolean; task?: CoordinatorTask; error?: string };
  /** Release a task */
  release(id: string, owner: string): boolean;
  /** Update task status */
  update(id: string, updates: Partial<CoordinatorTask>): CoordinatorTask | undefined;
}

/**
 * Coordinator configuration.
 */
export interface CoordinatorConfig {
  /** Maximum tasks to claim in one idle cycle */
  maxTasksPerCycle?: number;
  /** Idle check interval (ms) */
  idleCheckInterval?: number;
  /** Whether to auto-claim on idle */
  autoClaimEnabled?: boolean;
  /** Agent ID for claiming */
  agentId?: string;
  /** Session key for tracking */
  sessionKey?: string;
}

/**
 * Coordinator state.
 */
export interface CoordinatorState {
  /** Currently claimed tasks */
  claimedTasks: CoordinatorTask[];
  /** Tasks completed in this session */
  completedTasks: CoordinatorTask[];
  /** Last idle check time */
  lastIdleCheck: number;
  /** Whether coordinator is active */
  isActive: boolean;
}

/**
 * Coordinator action result.
 */
export interface CoordinatorActionResult {
  /** Tasks claimed */
  claimed: CoordinatorTask[];
  /** Tasks completed */
  completed: CoordinatorTask[];
  /** Whether coordinator took action */
  actionTaken: boolean;
  /** Error if occurred */
  error?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  maxTasksPerCycle: 5,
  idleCheckInterval: 30000, // 30 seconds
  autoClaimEnabled: true,
};

// ============================================================================
// Coordinator Implementation
// ============================================================================

/**
 * Task Coordinator - manages idle-loop task claiming.
 *
 * Claude Code innovation: Automatically claim ready tasks when idle.
 */
export class TaskCoordinator {
  private taskStore: CoordinatorTaskStore;
  private config: CoordinatorConfig;
  private state: CoordinatorState;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(taskStore: CoordinatorTaskStore, config?: CoordinatorConfig) {
    this.taskStore = taskStore;
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };
    this.state = {
      claimedTasks: [],
      completedTasks: [],
      lastIdleCheck: Date.now(),
      isActive: false,
    };
  }

  /**
   * Start the coordinator idle loop.
   */
  start(): void {
    if (this.state.isActive) {
      log.warn("Coordinator already active");
      return;
    }

    this.state.isActive = true;
    log.info(`Coordinator started, agent: ${this.config.agentId ?? "unknown"}`);

    // Start idle check timer
    if (this.config.autoClaimEnabled) {
      this.idleTimer = setInterval(() => {
        void this.idleCycle();
      }, this.config.idleCheckInterval ?? 30000);
    }
  }

  /**
   * Stop the coordinator.
   */
  stop(): void {
    this.state.isActive = false;

    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Release all claimed tasks
    for (const task of this.state.claimedTasks) {
      if (task.owner && this.config.agentId) {
        this.taskStore.release(task.id, this.config.agentId);
        log.info(`Released task ${task.id} on shutdown`);
      }
    }

    this.state.claimedTasks = [];
    log.info("Coordinator stopped");
  }

  /**
   * Execute one idle cycle.
   *
   * This is Claude Code's key innovation: when idle, claim and work on tasks.
   */
  async idleCycle(): Promise<CoordinatorActionResult> {
    if (!this.state.isActive) {
      return { claimed: [], completed: [], actionTaken: false };
    }

    this.state.lastIdleCheck = Date.now();
    log.info("Running idle cycle");

    try {
      // Get ready tasks
      const readyTasks = this.taskStore.getReadyTasks();

      if (readyTasks.length === 0) {
        log.info("No ready tasks available");
        return { claimed: [], completed: [], actionTaken: false };
      }

      // Claim tasks (up to max per cycle)
      const maxClaim = this.config.maxTasksPerCycle ?? 5;
      const toClaim = readyTasks.slice(0, maxClaim);

      const claimed: CoordinatorTask[] = [];
      for (const task of toClaim) {
        if (!this.config.agentId) {
          log.warn("Cannot claim task without agentId");
          break;
        }

        const result = this.taskStore.claim(task.id, this.config.agentId, this.config.sessionKey);

        if (result.success && result.task) {
          claimed.push(result.task);
          this.state.claimedTasks.push(result.task);
          log.info(`Claimed task ${task.id}: ${task.subject}`);
        } else {
          log.warn(`Failed to claim task ${task.id}: ${result.error}`);
        }
      }

      return {
        claimed,
        completed: [],
        actionTaken: claimed.length > 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Idle cycle error: ${errorMsg}`);
      return {
        claimed: [],
        completed: [],
        actionTaken: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Report task completion.
   */
  completeTask(taskId: string): boolean {
    const task = this.taskStore.get(taskId);
    if (!task) {
      log.warn(`Task ${taskId} not found`);
      return false;
    }

    // Mark as completed
    const updated = this.taskStore.update(taskId, { status: "completed" });

    if (updated) {
      // Remove from claimed, add to completed
      this.state.claimedTasks = this.state.claimedTasks.filter((t) => t.id !== taskId);
      this.state.completedTasks.push(updated);
      log.info(`Completed task ${taskId}: ${task.subject}`);
      return true;
    }

    return false;
  }

  /**
   * Get coordinator state.
   */
  getState(): CoordinatorState {
    return {
      ...this.state,
      claimedTasks: [...this.state.claimedTasks],
      completedTasks: [...this.state.completedTasks],
    };
  }

  /**
   * Get currently claimed tasks.
   */
  getClaimedTasks(): CoordinatorTask[] {
    return [...this.state.claimedTasks];
  }

  /**
   * Check if coordinator is idle (no claimed tasks in progress).
   */
  isIdle(): boolean {
    return this.state.claimedTasks.length === 0;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a TaskCoordinator.
 */
export function createTaskCoordinator(
  taskStore: CoordinatorTaskStore,
  config?: CoordinatorConfig,
): TaskCoordinator {
  return new TaskCoordinator(taskStore, config);
}

// ============================================================================
// Idle Loop Integration Helpers
// ============================================================================

/**
 * Check if should trigger idle cycle.
 *
 * Claude Code uses this to determine when to claim tasks.
 */
export function shouldTriggerIdleCycle(
  state: CoordinatorState,
  config: CoordinatorConfig,
): boolean {
  if (!config.autoClaimEnabled) {
    return false;
  }

  // Check if idle (no claimed tasks)
  if (state.claimedTasks.length > 0) {
    return false;
  }

  // Check interval elapsed
  const interval = config.idleCheckInterval ?? 30000;
  const elapsed = Date.now() - state.lastIdleCheck;

  return elapsed >= interval;
}

/**
 * Get next ready task for claiming.
 */
export function getNextReadyTask(taskStore: CoordinatorTaskStore): CoordinatorTask | null {
  const readyTasks = taskStore.getReadyTasks();

  if (readyTasks.length === 0) {
    return null;
  }

  // Return highest priority task
  // Sort by priority: critical > high > medium > low
  const priorityOrder = ["critical", "high", "medium", "low"];
  const sorted = readyTasks.toSorted((a: CoordinatorTask, b: CoordinatorTask) => {
    const aPriority = priorityOrder.indexOf(a.priority ?? "medium");
    const bPriority = priorityOrder.indexOf(b.priority ?? "medium");
    return aPriority - bPriority; // Lower index = higher priority
  });

  return sorted[0];
}

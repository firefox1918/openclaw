/**
 * Coordinator Loop Manager - Infrastructure-level coordinator for idle-loop task claiming.
 *
 * Key innovation: Uses JavaScript timers + Promise for reliable sleep with AbortSignal support,
 * replacing Agent directive-based sleep mechanisms.
 *
 * ## Concept (Claude Code 12-Layer Harness S11)
 *
 * Traditional: Wait for explicit task assignment
 * Coordinator: Idle loop → get_ready tasks → claim → execute → report
 *
 * This manager provides the infrastructure for coordinating task execution in the background,
 * with proper lifecycle management (start, stop, pause, resume) and error handling.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("coordinator-loop-manager");

// ============================================================================
// Types
// ============================================================================

/**
 * Coordinator loop status.
 */
export type CoordinatorStatusType = "idle" | "running" | "paused" | "stopped" | "error";

/**
 * Coordinator status snapshot.
 */
export interface CoordinatorStatus {
  /** Unique loop identifier */
  loopId: string;
  /** Current status */
  status: CoordinatorStatusType;
  /** Tasks completed in this session */
  tasksCompleted: number;
  /** Tasks failed in this session */
  tasksFailed: number;
  /** Consecutive failures (triggers pause when >= 5) */
  consecutiveFailures: number;
  /** When the loop was started */
  startedAt?: number;
  /** When the loop was paused */
  pausedAt?: number;
  /** When the loop was stopped */
  stoppedAt?: number;
}

/**
 * Coordinator configuration options.
 */
export interface CoordinatorOptions {
  /** Agent ID for claiming tasks */
  agentId?: string;
  /** Session key for tracking */
  sessionKey?: string;
  /** Idle check interval in milliseconds (default: 30000) */
  idleInterval?: number;
  /** Maximum retry attempts per task (default: 3) */
  maxRetries?: number;
  /** Timeout per task in milliseconds (default: 300000) */
  timeoutPerTask?: number;
}

/**
 * Task tool interface for coordinator operations.
 * This is the minimal interface needed for task claiming and execution.
 */
export interface TaskToolInterface {
  /** Get tasks that are ready to be claimed */
  get_ready(): Promise<{ success: boolean; tasks?: unknown[]; error?: string }>;
  /** Claim a task for execution */
  claim(
    id: string,
    owner: string,
    sessionKey?: string,
  ): Promise<{ success: boolean; task?: unknown; error?: string }>;
  /** Mark a task as completed */
  complete(id: string): Promise<{ success: boolean; error?: string }>;
  /** Mark a task as failed */
  mark_failed(id: string, error: string): Promise<{ success: boolean; error?: string }>;
}

/**
 * Coordinator Loop Manager interface.
 */
export interface CoordinatorLoopManager {
  /** Start the coordinator loop */
  start(): void;
  /** Stop the coordinator loop */
  stop(): void;
  /** Pause the coordinator loop */
  pause(): void;
  /** Resume the coordinator loop */
  resume(): void;
  /** Get current status snapshot */
  getStatus(): CoordinatorStatus;
}

// ============================================================================
// AbortError Class
// ============================================================================

/**
 * Error thrown when a sleep operation is aborted via AbortSignal.
 */
export class AbortError extends Error {
  constructor(message: string = "Sleep aborted") {
    super(message);
    this.name = "AbortError";
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique coordinator loop ID.
 */
function generateCoordinatorLoopId(): string {
  const uuid = crypto.randomUUID();
  return `coord-${uuid}`;
}

/**
 * Sleep function with AbortSignal support.
 *
 * @param ms - Duration to sleep in milliseconds
 * @param signal - Optional AbortSignal to interrupt the sleep
 * @returns Promise that resolves after the specified duration, or rejects if aborted
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already aborted
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }

    const timer = setTimeout(resolve, ms);

    // Listen for abort signal
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_COORDINATOR_OPTIONS = {
  agentId: undefined as string | undefined,
  sessionKey: undefined as string | undefined,
  idleInterval: 30000, // 30 seconds
  maxRetries: 3,
  timeoutPerTask: 300000, // 5 minutes
};

// ============================================================================
// Coordinator Loop Manager Implementation
// ============================================================================

/**
 * Internal coordinator loop manager state.
 */
export class CoordinatorLoopManagerImpl implements CoordinatorLoopManager {
  private loopId: string;
  private options: typeof DEFAULT_COORDINATOR_OPTIONS;
  private statusState: CoordinatorStatus;
  private idleTimer?: ReturnType<typeof setInterval>;
  private abortController?: AbortController;
  private taskTool?: TaskToolInterface;
  private runLoopFn?: () => Promise<void>;

  constructor(options?: CoordinatorOptions) {
    this.loopId = generateCoordinatorLoopId();
    this.options = { ...DEFAULT_COORDINATOR_OPTIONS, ...options };
    this.statusState = {
      loopId: this.loopId,
      status: "stopped",
      tasksCompleted: 0,
      tasksFailed: 0,
      consecutiveFailures: 0,
    };
  }

  /**
   * Set the task tool for dependency injection.
   */
  setTaskTool(taskTool: TaskToolInterface): void {
    this.taskTool = taskTool;
  }

  /**
   * Set a custom run loop function.
   */
  setRunLoop(runLoopFn: () => Promise<void>): void {
    this.runLoopFn = runLoopFn;
  }

  /**
   * Start the coordinator loop.
   */
  start(): void {
    if (this.statusState.status === "running" || this.statusState.status === "idle") {
      log.warn(`Coordinator loop ${this.loopId} already started`);
      return;
    }

    if (this.statusState.status === "error") {
      log.warn(`Cannot start coordinator loop ${this.loopId} in error state`);
      return;
    }

    this.abortController = new AbortController();
    this.statusState.status = "idle";
    this.statusState.startedAt = Date.now();
    this.statusState.stoppedAt = undefined;
    this.statusState.pausedAt = undefined;

    log.info(
      `Coordinator loop ${this.loopId} started, agent: ${this.options.agentId ?? "unknown"}`,
    );

    // Start idle check timer
    this.idleTimer = setInterval(() => {
      void this.idleCycle();
    }, this.options.idleInterval);
  }

  /**
   * Stop the coordinator loop.
   */
  stop(): void {
    if (this.statusState.status === "stopped") {
      return;
    }

    // Clear idle timer
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    // Abort any pending operations
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }

    this.statusState.status = "stopped";
    this.statusState.stoppedAt = Date.now();

    log.info(`Coordinator loop ${this.loopId} stopped`);
  }

  /**
   * Pause the coordinator loop.
   */
  pause(): void {
    if (this.statusState.status !== "idle" && this.statusState.status !== "running") {
      log.warn(
        `Cannot pause coordinator loop ${this.loopId} in status: ${this.statusState.status}`,
      );
      return;
    }

    // Clear idle timer
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }

    this.statusState.status = "paused";
    this.statusState.pausedAt = Date.now();

    log.info(`Coordinator loop ${this.loopId} paused`);
  }

  /**
   * Resume the coordinator loop.
   */
  resume(): void {
    if (this.statusState.status !== "paused") {
      log.warn(
        `Cannot resume coordinator loop ${this.loopId} in status: ${this.statusState.status}`,
      );
      return;
    }

    this.statusState.status = "idle";
    this.statusState.pausedAt = undefined;

    log.info(`Coordinator loop ${this.loopId} resumed`);

    // Restart idle check timer
    this.idleTimer = setInterval(() => {
      void this.idleCycle();
    }, this.options.idleInterval);
  }

  /**
   * Get current status snapshot.
   */
  getStatus(): CoordinatorStatus {
    return { ...this.statusState };
  }

  /**
   * Execute one idle cycle.
   *
   * This is the core idle loop logic - claims and executes ready tasks.
   */
  async idleCycle(): Promise<void> {
    // Use custom run loop if provided
    if (this.runLoopFn) {
      await this.runLoopFn();
      return;
    }

    // Default run loop implementation
    await this.runLoop();
  }

  /**
   * Run the main coordinator loop.
   *
   * Gets ready tasks, claims them, executes them, and reports results.
   * Handles errors and tracks consecutive failures.
   */
  async runLoop(): Promise<void> {
    if (!this.taskTool) {
      log.debug(`Coordinator loop ${this.loopId}: no task tool set, skipping idle cycle`);
      return;
    }

    if (!this.options.agentId) {
      log.warn(`Coordinator loop ${this.loopId}: no agentId set, cannot claim tasks`);
      return;
    }

    this.statusState.status = "running";

    try {
      // Get ready tasks
      const getReadyResult = await this.taskTool.get_ready();

      if (!getReadyResult.success || !getReadyResult.tasks || getReadyResult.tasks.length === 0) {
        log.info(`Coordinator loop ${this.loopId}: no ready tasks found`);
        this.statusState.status = "idle";
        return;
      }

      log.info(`Coordinator loop ${this.loopId}: found ${getReadyResult.tasks.length} ready tasks`);

      // Claim and execute each task
      for (const task of getReadyResult.tasks) {
        const taskId = (task as { id?: string }).id;
        if (!taskId) {
          log.warn(`Coordinator loop ${this.loopId}: task missing id, skipping`);
          continue;
        }

        // Claim the task
        const claimResult = await this.taskTool.claim(
          taskId,
          this.options.agentId,
          this.options.sessionKey,
        );

        if (!claimResult.success) {
          log.warn(
            `Coordinator loop ${this.loopId}: failed to claim task ${taskId}: ${claimResult.error}`,
          );
          continue;
        }

        log.info(`Coordinator loop ${this.loopId}: claimed task ${taskId}`);

        // Execute the task (placeholder - actual execution depends on task type)
        try {
          // Task execution would happen here
          // For now, we just mark it as completed
          await this.taskTool.complete(taskId);
          this.statusState.tasksCompleted++;
          this.statusState.consecutiveFailures = 0; // Reset on success
          log.info(`Coordinator loop ${this.loopId}: completed task ${taskId}`);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await this.taskTool.mark_failed(taskId, errorMessage);
          this.statusState.tasksFailed++;
          this.statusState.consecutiveFailures++;
          log.error(`Coordinator loop ${this.loopId}: failed task ${taskId}: ${errorMessage}`);

          // Check for consecutive failures threshold
          if (this.statusState.consecutiveFailures >= 5) {
            this.statusState.status = "error";
            log.error(
              `Coordinator loop ${this.loopId}: paused due to ${this.statusState.consecutiveFailures} consecutive failures`,
            );
            return;
          }
        }
      }

      this.statusState.status = "idle";
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`Coordinator loop ${this.loopId}: runLoop error: ${errorMessage}`);
      this.statusState.tasksFailed++;
      this.statusState.consecutiveFailures++;

      if (this.statusState.consecutiveFailures >= 5) {
        this.statusState.status = "error";
        log.error(
          `Coordinator loop ${this.loopId}: paused due to ${this.statusState.consecutiveFailures} consecutive failures`,
        );
      } else {
        this.statusState.status = "idle";
      }
    }
  }

  /**
   * Increment tasks completed counter (for testing).
   */
  incrementTasksCompleted(): void {
    this.statusState.tasksCompleted++;
  }

  /**
   * Increment tasks failed counter (for testing).
   */
  incrementTasksFailed(): void {
    this.statusState.tasksFailed++;
  }

  /**
   * Increment consecutive failures counter (for testing).
   */
  incrementConsecutiveFailures(): void {
    this.statusState.consecutiveFailures++;
    if (this.statusState.consecutiveFailures >= 5) {
      this.statusState.status = "error";
      log.error(
        `Coordinator loop ${this.loopId} paused due to ${this.statusState.consecutiveFailures} consecutive failures`,
      );
    }
  }

  /**
   * Reset consecutive failures counter (for testing).
   */
  resetConsecutiveFailures(): void {
    this.statusState.consecutiveFailures = 0;
  }

  /**
   * Get options (for testing).
   */
  getOptions(): typeof DEFAULT_COORDINATOR_OPTIONS {
    return { ...this.options };
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a CoordinatorLoopManager.
 */
export function createCoordinatorLoopManager(options?: CoordinatorOptions): CoordinatorLoopManager {
  return new CoordinatorLoopManagerImpl(options);
}

// ============================================================================
// Testing Exports
// ============================================================================

/**
 * Global coordinator loop manager instance for testing (singleton pattern).
 */
let globalCoordinatorLoopManager: CoordinatorLoopManagerImpl | null = null;

export const __testing = {
  /** Reset the global manager instance */
  resetCoordinatorLoopManager(): void {
    if (globalCoordinatorLoopManager) {
      globalCoordinatorLoopManager.stop();
      globalCoordinatorLoopManager = null;
    }
  },

  /** Get the global manager instance */
  getCoordinatorLoopManager(): CoordinatorLoopManagerImpl | null {
    return globalCoordinatorLoopManager;
  },

  /** Set the global manager instance */
  setCoordinatorLoopManager(manager: CoordinatorLoopManagerImpl): void {
    globalCoordinatorLoopManager = manager;
  },

  /** Sleep function with AbortSignal support */
  sleep,

  /** AbortError class */
  AbortError,

  /** Increment tasks completed counter */
  incrementTasksCompleted(manager: CoordinatorLoopManager): void {
    if (manager instanceof CoordinatorLoopManagerImpl) {
      manager.incrementTasksCompleted();
    }
  },

  /** Increment tasks failed counter */
  incrementTasksFailed(manager: CoordinatorLoopManager): void {
    if (manager instanceof CoordinatorLoopManagerImpl) {
      manager.incrementTasksFailed();
    }
  },

  /** Increment consecutive failures counter */
  incrementConsecutiveFailures(manager: CoordinatorLoopManager): void {
    if (manager instanceof CoordinatorLoopManagerImpl) {
      manager.incrementConsecutiveFailures();
    }
  },

  /** Reset consecutive failures counter */
  resetConsecutiveFailures(manager: CoordinatorLoopManager): void {
    if (manager instanceof CoordinatorLoopManagerImpl) {
      manager.resetConsecutiveFailures();
    }
  },

  /** Set task tool for a manager */
  setTaskTool(manager: CoordinatorLoopManager, taskTool: TaskToolInterface): void {
    if (manager instanceof CoordinatorLoopManagerImpl) {
      manager.setTaskTool(taskTool);
    }
  },

  /** Set run loop function for a manager */
  setRunLoop(manager: CoordinatorLoopManager, runLoopFn: () => Promise<void>): void {
    if (manager instanceof CoordinatorLoopManagerImpl) {
      manager.setRunLoop(runLoopFn);
    }
  },
};

// Update factory to use singleton for testing
export function _createCoordinatorLoopManagerSingleton(
  options?: CoordinatorOptions,
): CoordinatorLoopManager {
  if (globalCoordinatorLoopManager) {
    globalCoordinatorLoopManager.stop();
  }
  globalCoordinatorLoopManager = new CoordinatorLoopManagerImpl(options);
  return globalCoordinatorLoopManager;
}

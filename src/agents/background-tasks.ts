/**
 * Background Tasks - Claude Code's persistent background execution mechanism.
 *
 * Key innovation: Tasks can run in background, persisting across session boundaries.
 *
 * ## Concept (Claude Code 12-Layer Harness S08)
 *
 * Traditional: All tasks tied to session lifecycle
 * Background Tasks: Decoupled execution → Continue even after session ends
 *
 * ## Integration Points
 *
 * 1. sessions-spawn-tool.ts - Background subagent spawning
 * 2. subagent-spawn.ts - Fork subagent creation
 * 3. Task management - Task persistence
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("background-tasks");

// ============================================================================
// Types
// ============================================================================

/**
 * Background task status.
 */
export type BackgroundTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Background task execution result.
 */
export interface BackgroundTaskResult {
  /** Task ID */
  taskId: string;
  /** Final status */
  status: BackgroundTaskStatus;
  /** Execution output */
  output?: string;
  /** Error if failed */
  error?: string;
  /** Execution duration (ms) */
  duration?: number;
  /** When started */
  startedAt?: number;
  /** When completed */
  completedAt?: number;
}

/**
 * Background task configuration.
 */
export interface BackgroundTaskConfig {
  /** Task directive */
  directive: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to retry on failure */
  retry?: boolean;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Session key for tracking */
  sessionKey?: string;
  /** Workspace directory */
  workspaceDir?: string;
  /** Additional context */
  additionalContext?: Record<string, unknown>;
  /** Internal retry count */
  _retries?: number;
}

/**
 * Background task handle.
 */
export interface BackgroundTaskHandle {
  /** Task ID */
  id: string;
  /** Configuration */
  config: BackgroundTaskConfig;
  /** Current status */
  status: BackgroundTaskStatus;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Current message */
  message?: string;
  /** When started */
  startedAt?: number;
  /** When completed */
  completedAt?: number;
  /** Execution duration (ms) */
  duration?: number;
  /** Result when complete */
  result?: BackgroundTaskResult;
}

/**
 * Background task executor function.
 */
export type BackgroundExecutorFn = (config: BackgroundTaskConfig) => Promise<BackgroundTaskResult>;

/**
 * Background tasks manager configuration.
 */
export interface BackgroundTasksManagerConfig {
  /** Maximum concurrent background tasks */
  maxConcurrent?: number;
  /** Default timeout (ms) */
  defaultTimeout?: number;
  /** Task check interval (ms) */
  checkInterval?: number;
  /** Whether to auto-start pending tasks */
  autoStart?: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_MANAGER_CONFIG: BackgroundTasksManagerConfig = {
  maxConcurrent: 5,
  defaultTimeout: 300000, // 5 minutes
  checkInterval: 10000,
  autoStart: true,
};

// ============================================================================
// Background Tasks Manager
// ============================================================================

/**
 * Background Tasks Manager - manages persistent background execution.
 *
 * Claude Code innovation: Tasks continue running even after session ends.
 */
export class BackgroundTasksManager {
  private tasks: Map<string, BackgroundTaskHandle> = new Map();
  private executor?: BackgroundExecutorFn;
  private config: BackgroundTasksManagerConfig;
  private checkTimer?: ReturnType<typeof setInterval>;
  private activeCount = 0;

  constructor(config?: BackgroundTasksManagerConfig) {
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...config };
  }

  /**
   * Set the executor function.
   */
  setExecutor(executor: BackgroundExecutorFn): void {
    this.executor = executor;
  }

  /**
   * Start the manager.
   */
  start(): void {
    if (this.checkTimer) {
      return;
    }

    log.info("Background tasks manager started");

    if (this.config.autoStart) {
      this.checkTimer = setInterval(() => {
        void this.processPendingTasks();
      }, this.config.checkInterval ?? 10000);
    }
  }

  /**
   * Stop the manager.
   */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }

    // Cancel running tasks
    for (const [id, handle] of this.tasks) {
      if (handle.status === "running") {
        handle.status = "cancelled";
        log.info(`Cancelled background task ${id}`);
      }
    }

    log.info("Background tasks manager stopped");
  }

  /**
   * Add a background task.
   */
  addTask(config: BackgroundTaskConfig): BackgroundTaskHandle {
    const id = generateBackgroundTaskId();

    const handle: BackgroundTaskHandle = {
      id,
      config,
      status: "pending",
      progress: 0,
      message: "Task queued",
    };

    this.tasks.set(id, handle);
    log.info(`Added background task ${id}: ${config.directive}`);

    // Auto-process if enabled
    if (this.config.autoStart) {
      void this.processPendingTasks();
    }

    return handle;
  }

  /**
   * Get a task by ID.
   */
  getTask(id: string): BackgroundTaskHandle | undefined {
    return this.tasks.get(id);
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): BackgroundTaskHandle[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get running tasks.
   */
  getRunningTasks(): BackgroundTaskHandle[] {
    return this.getAllTasks().filter((t) => t.status === "running");
  }

  /**
   * Get completed tasks.
   */
  getCompletedTasks(): BackgroundTaskHandle[] {
    return this.getAllTasks().filter(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
    );
  }

  /**
   * Process pending tasks.
   */
  async processPendingTasks(): Promise<void> {
    if (!this.executor) {
      log.warn("No executor set, cannot process tasks");
      return;
    }

    // Check concurrency limit
    if (this.activeCount >= (this.config.maxConcurrent ?? 5)) {
      return;
    }

    // Get pending tasks
    const pending = this.getAllTasks().filter((t) => t.status === "pending");

    for (const handle of pending) {
      if (this.activeCount >= (this.config.maxConcurrent ?? 5)) {
        break;
      }

      // Start task execution
      void this.executeTask(handle);
    }
  }

  /**
   * Execute a background task.
   */
  private async executeTask(handle: BackgroundTaskHandle): Promise<void> {
    if (!this.executor) {
      return;
    }

    handle.status = "running";
    handle.message = "Executing";
    handle.startedAt = Date.now();
    this.activeCount++;

    log.info(`Executing background task ${handle.id}`);

    try {
      const result = await this.executor(handle.config);

      handle.status = result.status;
      handle.result = result;
      handle.completedAt = Date.now();
      handle.duration = result.duration ?? handle.completedAt - handle.startedAt;

      if (result.status === "completed") {
        handle.progress = 100;
        handle.message = "Completed";
        log.info(`Background task ${handle.id} completed`);
      } else if (result.status === "failed") {
        handle.message = `Failed: ${result.error ?? "unknown error"}`;
        log.error(`Background task ${handle.id} failed: ${result.error}`);

        // Retry if configured
        if (handle.config.retry && handle.config.maxRetries) {
          const retries = handle.config._retries ?? 0;
          if (retries < handle.config.maxRetries) {
            handle.config._retries = retries + 1;
            handle.status = "pending";
            handle.message = `Retrying (${retries + 1}/${handle.config.maxRetries})`;
            log.info(`Retrying background task ${handle.id}`);
          }
        }
      }
    } catch (error) {
      handle.status = "failed";
      handle.result = {
        taskId: handle.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      handle.message = `Failed: ${handle.result.error}`;
      log.error(`Background task ${handle.id} error: ${handle.result.error}`);
    }

    this.activeCount--;
  }

  /**
   * Cancel a task.
   */
  cancelTask(id: string): boolean {
    const handle = this.tasks.get(id);
    if (!handle) {
      return false;
    }

    if (handle.status === "running") {
      handle.status = "cancelled";
      handle.message = "Cancelled";
      log.info(`Cancelled background task ${id}`);
      return true;
    }

    if (handle.status === "pending") {
      handle.status = "cancelled";
      handle.message = "Cancelled before start";
      log.info(`Cancelled pending background task ${id}`);
      return true;
    }

    return false; // Cannot cancel completed/failed tasks
  }

  /**
   * Clear completed tasks.
   */
  clearCompleted(): void {
    for (const [id, handle] of this.tasks) {
      if (
        handle.status === "completed" ||
        handle.status === "failed" ||
        handle.status === "cancelled"
      ) {
        this.tasks.delete(id);
      }
    }
    log.info("Cleared completed background tasks");
  }

  /**
   * Get manager stats.
   */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const tasks = this.getAllTasks();
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "pending").length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a BackgroundTasksManager.
 */
export function createBackgroundTasksManager(
  config?: BackgroundTasksManagerConfig,
): BackgroundTasksManager {
  return new BackgroundTasksManager(config);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique background task ID.
 */
function generateBackgroundTaskId(): string {
  return `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Minimal task interface for background compatibility check.
 */
interface MinimalTask {
  status: string;
  blockedBy: string[];
}

/**
 * Check if a task can be run in background.
 */
export function canRunInBackground(task: MinimalTask): boolean {
  // Tasks with dependencies cannot run in background alone
  if (task.blockedBy.length > 0) {
    return false;
  }

  // Completed/failed tasks cannot run
  if (task.status === "completed" || task.status === "failed") {
    return false;
  }

  return true;
}

/**
 * Minimal task interface with subject.
 */
interface TaskWithSubject {
  id: string;
  subject: string;
  priority?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Convert Task to BackgroundTaskConfig.
 */
export function taskToBackgroundConfig(task: TaskWithSubject): BackgroundTaskConfig {
  return {
    directive: task.subject,
    sessionKey: task.metadata?.sessionKey as string | undefined,
    workspaceDir: task.metadata?.workspaceDir as string | undefined,
    additionalContext: {
      taskId: task.id,
      priority: task.priority,
      tags: task.tags,
      ...task.metadata,
    },
  };
}

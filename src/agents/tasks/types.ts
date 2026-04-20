/**
 * Task system type definitions.
 *
 * Provides task data structures for multi-step task orchestration.
 * Inspired by Claude Code's task architecture but adapted for OpenClaw.
 *
 * ## Integration Points
 *
 * 1. Subagent spawn - tasks can spawn subagents for execution
 * 2. Task tool - Agent can create, update, claim tasks
 * 3. Dependency graph - manages task dependencies
 *
 * ## Task Lifecycle
 *
 * ```
 * pending → in_progress → completed
 *          ↓
 *        blocked → pending (when blocker resolved)
 * ```
 */

// ============================================================================
// Task Status
// ============================================================================

/**
 * Task status values.
 */
export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Check if a status is valid.
 */
export function isValidTaskStatus(status: string): boolean {
  return TASK_STATUSES.includes(status as TaskStatus);
}

// ============================================================================
// Task Priority
// ============================================================================

/**
 * Task priority levels.
 */
export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

// ============================================================================
// Task Definition
// ============================================================================

/**
 * A task represents a unit of work that an agent can perform.
 *
 * Tasks can have dependencies on other tasks, forming a dependency graph.
 * The task system ensures tasks are executed in the correct order.
 */
export type Task = {
  /** Unique task identifier */
  id: string;
  /** Brief description of what the task involves */
  subject: string;
  /** Current task status */
  status: TaskStatus;
  /** Task priority */
  priority?: TaskPriority;
  /** Agent ID that owns/claimed this task */
  owner?: string | null;
  /** Session key of the owning agent */
  ownerSessionKey?: string | null;
  /** Task creation timestamp */
  createdAt: number;
  /** Task last update timestamp */
  updatedAt: number;
  /** IDs of tasks that this task blocks (cannot start until this completes) */
  blocks: string[];
  /** IDs of tasks that block this task (must complete before this can start) */
  blockedBy: string[];
  /** Optional detailed description */
  description?: string;
  /** Optional metadata for task-specific data */
  metadata?: Record<string, unknown>;
  /** Optional parent task ID (for subtasks) */
  parentTaskId?: string;
  /** Optional deadline timestamp */
  deadline?: number;
  /** Optional tags for categorization */
  tags?: string[];
};

/**
 * Task creation parameters.
 */
export type CreateTaskParams = {
  /** Task ID (auto-generated if not provided) */
  id?: string;
  /** Task subject/description */
  subject: string;
  /** Initial status (defaults to 'pending') */
  status?: TaskStatus;
  /** Priority level */
  priority?: TaskPriority;
  /** Task description */
  description?: string;
  /** Metadata */
  metadata?: Record<string, unknown>;
  /** Parent task ID */
  parentTaskId?: string;
  /** Deadline */
  deadline?: number;
  /** Tags */
  tags?: string[];
};

/**
 * Task update parameters.
 */
export type UpdateTaskParams = {
  /** Update status */
  status?: TaskStatus;
  /** Update subject */
  subject?: string;
  /** Update priority */
  priority?: TaskPriority;
  /** Update description */
  description?: string;
  /** Update metadata (merged with existing) */
  metadata?: Record<string, unknown>;
  /** Update deadline */
  deadline?: number;
  /** Update tags */
  tags?: string[];
  /** Update owner */
  owner?: string | null;
  /** Update owner session key */
  ownerSessionKey?: string | null;
};

// ============================================================================
// Task Graph
// ============================================================================

/**
 * Task graph represents the dependency relationships between tasks.
 */
export type TaskGraph = {
  /** All tasks in the graph */
  tasks: Map<string, Task>;
  /** Tasks that have no blockers (ready to be claimed) */
  readyTasks: Set<string>;
  /** Tasks currently in progress */
  inProgressTasks: Set<string>;
  /** Tasks that are blocked */
  blockedTasks: Set<string>;
  /** Tasks that are completed */
  completedTasks: Set<string>;
};

// ============================================================================
// Task Claim Result
// ============================================================================

/**
 * Result of attempting to claim a task.
 */
export type ClaimTaskResult = {
  /** Whether the claim was successful */
  success: boolean;
  /** The claimed task (if successful) */
  task?: Task;
  /** Error message (if failed) */
  error?: string;
  /** Reason for failure */
  reason?: "not_found" | "already_claimed" | "blocked" | "completed" | "cancelled";
};

// ============================================================================
// Task Query
// ============================================================================

/**
 * Parameters for querying tasks.
 */
export type TaskQueryParams = {
  /** Filter by status */
  status?: TaskStatus | TaskStatus[];
  /** Filter by owner */
  owner?: string;
  /** Filter by priority */
  priority?: TaskPriority | TaskPriority[];
  /** Filter by tags */
  tags?: string[];
  /** Filter by parent task */
  parentTaskId?: string;
  /** Include blocked tasks */
  includeBlocked?: boolean;
  /** Sort by field */
  sortBy?: "createdAt" | "updatedAt" | "priority";
  /** Sort direction */
  sortDirection?: "asc" | "desc";
  /** Limit results */
  limit?: number;
};

/**
 * Task query result.
 */
export type TaskQueryResult = {
  /** Matching tasks */
  tasks: Task[];
  /** Total count before limit */
  total: number;
};

// ============================================================================
// Task Store Events
// ============================================================================

/**
 * Events emitted by the task store.
 */
export type TaskStoreEvent = {
  type: "created" | "updated" | "deleted" | "claimed" | "released" | "completed";
  task: Task;
  previousStatus?: TaskStatus;
  previousOwner?: string | null;
};

/**
 * Task store event listener.
 */
export type TaskStoreEventListener = (event: TaskStoreEvent) => void | Promise<void>;

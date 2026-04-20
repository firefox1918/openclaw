/**
 * Task system module entry point.
 *
 * Provides task orchestration capabilities:
 * - Task creation and management
 * - Dependency graph management
 * - Task claiming with atomic locks
 *
 * ## Integration Points
 *
 * 1. Task tool - creates and manages tasks
 * 2. Subagent spawn - tasks can spawn subagents
 * 3. Agent run - claims tasks at execution start
 */

// Types
export type {
  ClaimTaskResult,
  CreateTaskParams,
  Task,
  TaskGraph,
  TaskPriority,
  TaskQueryParams,
  TaskQueryResult,
  TaskStatus,
  TaskStoreEvent,
  TaskStoreEventListener,
  UpdateTaskParams,
} from "./types.js";

export { TASK_PRIORITIES, TASK_STATUSES, isValidTaskStatus } from "./types.js";

// Store
export { createTaskStore, TaskStore } from "./store.js";

// Dependency Graph
export {
  addDependency,
  getAllDependencies,
  getAllDependents,
  getBlockedTasks,
  getReadyTasks,
  hasDependencyCycle,
  removeDependency,
  resolveDependencies,
  updateStatusBasedOnBlockers,
  validateDependencyGraph,
} from "./dependency-graph.js";

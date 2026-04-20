/**
 * Task dependency graph management.
 *
 * Manages bidirectional dependencies between tasks:
 * - blocks: tasks that cannot start until this task completes
 * - blockedBy: tasks that must complete before this can start
 *
 * ## Key Operations
 *
 * - addDependency(fromId, toId): Mark fromId blocks toId
 * - removeDependency(fromId, toId): Remove blocking relationship
 * - getReadyTasks(): Tasks with no blockers that can be claimed
 * - getBlockedTasks(): Tasks waiting for blockers
 * - resolveDependencies(taskId): Update graph when task completes
 *
 * ## Cycle Detection
 *
 * The graph validates new dependencies to prevent cycles:
 * - A task cannot block itself (direct or indirect)
 * - Adding a dependency checks for transitive cycles
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { Task, TaskStatus } from "./types.js";

const log = createSubsystemLogger("tasks/dependency-graph");

// ============================================================================
// Graph Operations
// ============================================================================

/**
 * Add a blocking dependency.
 *
 * After this call, `fromId` blocks `toId` (toId cannot start until fromId completes).
 *
 * @param tasks - Map of all tasks
 * @param fromId - Task that blocks
 * @param toId - Task that is blocked
 * @returns true if dependency was added, false if it would create a cycle
 */
export function addDependency(tasks: Map<string, Task>, fromId: string, toId: string): boolean {
  if (fromId === toId) {
    log.warn(`Cannot add self-dependency: ${fromId}`);
    return false;
  }

  // Check for existing dependency
  const fromTask = tasks.get(fromId);
  const toTask = tasks.get(toId);

  if (!fromTask || !toTask) {
    log.warn(`Task not found: from=${fromId}, to=${toId}`);
    return false;
  }

  // Check for cycle (if fromId is already blocked by toId, adding this would create cycle)
  if (hasDependencyCycle(tasks, fromId, toId)) {
    log.warn(`Dependency cycle detected: ${fromId} -> ${toId}`);
    return false;
  }

  // Add bidirectional relationship
  if (!fromTask.blocks.includes(toId)) {
    fromTask.blocks.push(toId);
  }
  if (!toTask.blockedBy.includes(fromId)) {
    toTask.blockedBy.push(fromId);
  }

  log.info(`Added dependency: ${fromId} blocks ${toId}`);
  return true;
}

/**
 * Remove a blocking dependency.
 *
 * @param tasks - Map of all tasks
 * @param fromId - Task that was blocking
 * @param toId - Task that was blocked
 * @returns true if dependency was removed
 */
export function removeDependency(tasks: Map<string, Task>, fromId: string, toId: string): boolean {
  const fromTask = tasks.get(fromId);
  const toTask = tasks.get(toId);

  if (!fromTask || !toTask) {
    return false;
  }

  // Remove bidirectional relationship
  fromTask.blocks = fromTask.blocks.filter((id) => id !== toId);
  toTask.blockedBy = toTask.blockedBy.filter((id) => id !== fromId);

  log.info(`Removed dependency: ${fromId} no longer blocks ${toId}`);
  return true;
}

/**
 * Check if adding a dependency would create a cycle.
 *
 * Uses DFS to check if toId can reach fromId through existing blockedBy edges.
 */
export function hasDependencyCycle(
  tasks: Map<string, Task>,
  fromId: string,
  toId: string,
): boolean {
  // If toId blocks fromId (directly or transitively), adding fromId -> toId creates cycle
  const visited = new Set<string>();
  const stack = [toId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === fromId) {
      return true; // Cycle found
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const task = tasks.get(current);
    if (task) {
      // Check all tasks that this task blocks
      for (const blockedId of task.blocks) {
        if (!visited.has(blockedId)) {
          stack.push(blockedId);
        }
      }
    }
  }

  return false;
}

/**
 * Get all tasks that are ready to be claimed (no blockers, status pending).
 */
export function getReadyTasks(tasks: Map<string, Task>): Task[] {
  const ready: Task[] = [];

  for (const task of tasks.values()) {
    if (task.status === "pending" && task.blockedBy.length === 0) {
      ready.push(task);
    }
  }

  return ready;
}

/**
 * Get all tasks that are blocked (have blockers, status blocked).
 */
export function getBlockedTasks(tasks: Map<string, Task>): Task[] {
  const blocked: Task[] = [];

  for (const task of tasks.values()) {
    if (task.blockedBy.length > 0 && task.status !== "completed" && task.status !== "cancelled") {
      blocked.push(task);
    }
  }

  return blocked;
}

/**
 * Resolve dependencies when a task completes.
 *
 * Updates all tasks that were blocked by this task:
 * - Removes the completed task from their blockedBy list
 * - If they have no remaining blockers, changes status to pending
 *
 * @returns List of tasks that became unblocked
 */
export function resolveDependencies(tasks: Map<string, Task>, completedTaskId: string): string[] {
  const completedTask = tasks.get(completedTaskId);
  if (!completedTask) {
    return [];
  }

  const unblocked: string[] = [];

  // Find all tasks that were blocked by this completed task
  for (const blockedId of completedTask.blocks) {
    const blockedTask = tasks.get(blockedId);
    if (!blockedTask) {
      continue;
    }

    // Remove completed task from blockedBy
    blockedTask.blockedBy = blockedTask.blockedBy.filter((id) => id !== completedTaskId);

    // If no remaining blockers and status was blocked, make it pending
    if (blockedTask.blockedBy.length === 0 && blockedTask.status === "blocked") {
      blockedTask.status = "pending";
      blockedTask.updatedAt = Date.now();
      unblocked.push(blockedId);
      log.info(`Task ${blockedId} unblocked by completion of ${completedTaskId}`);
    }
  }

  // Clear the completed task's blocks list
  completedTask.blocks = [];

  return unblocked;
}

/**
 * Update task status based on blockers.
 *
 * If a task has blockers and is pending, change to blocked.
 * If a task has no blockers and is blocked, change to pending.
 */
export function updateStatusBasedOnBlockers(
  tasks: Map<string, Task>,
  taskId: string,
): TaskStatus | null {
  const task = tasks.get(taskId);
  if (!task) {
    return null;
  }

  const hasBlockers = task.blockedBy.length > 0;
  const allBlockersComplete = task.blockedBy.every((id) => {
    const blocker = tasks.get(id);
    return blocker?.status === "completed" || blocker?.status === "cancelled";
  });

  let newStatus: TaskStatus | null = null;

  if (task.status === "pending" && hasBlockers && !allBlockersComplete) {
    newStatus = "blocked";
  } else if (task.status === "blocked" && (!hasBlockers || allBlockersComplete)) {
    newStatus = "pending";
  }

  if (newStatus && newStatus !== task.status) {
    task.status = newStatus;
    task.updatedAt = Date.now();
    log.info(`Task ${taskId} status updated to ${newStatus}`);
  }

  return newStatus;
}

/**
 * Get all dependencies of a task (transitive).
 *
 * Returns all tasks that must complete before this task can start.
 */
export function getAllDependencies(tasks: Map<string, Task>, taskId: string): string[] {
  const visited = new Set<string>();
  const dependencies: string[] = [];
  const stack = [taskId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const task = tasks.get(current);

    if (!task) {
      continue;
    }

    for (const blockerId of task.blockedBy) {
      if (!visited.has(blockerId)) {
        visited.add(blockerId);
        dependencies.push(blockerId);
        stack.push(blockerId);
      }
    }
  }

  return dependencies;
}

/**
 * Get all tasks that depend on this task (transitive).
 *
 * Returns all tasks that cannot start until this task completes.
 */
export function getAllDependents(tasks: Map<string, Task>, taskId: string): string[] {
  const visited = new Set<string>();
  const dependents: string[] = [];
  const stack = [taskId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const task = tasks.get(current);

    if (!task) {
      continue;
    }

    for (const blockedId of task.blocks) {
      if (!visited.has(blockedId)) {
        visited.add(blockedId);
        dependents.push(blockedId);
        stack.push(blockedId);
      }
    }
  }

  return dependents;
}

/**
 * Validate the entire dependency graph.
 *
 * Checks for:
 * - Self-dependencies
 * - Cycles
 * - Missing task references
 *
 * @returns List of validation errors
 */
export function validateDependencyGraph(tasks: Map<string, Task>): string[] {
  const errors: string[] = [];

  for (const task of tasks.values()) {
    // Check for self-dependency
    if (task.blocks.includes(task.id) || task.blockedBy.includes(task.id)) {
      errors.push(`Task ${task.id} has self-dependency`);
    }

    // Check for missing references
    for (const blockerId of task.blockedBy) {
      if (!tasks.has(blockerId)) {
        errors.push(`Task ${task.id} blockedBy missing task ${blockerId}`);
      }
    }

    for (const blockedId of task.blocks) {
      if (!tasks.has(blockedId)) {
        errors.push(`Task ${task.id} blocks missing task ${blockedId}`);
      }
    }
  }

  // Check for cycles
  for (const task of tasks.values()) {
    if (hasDependencyCycle(tasks, task.id, task.id)) {
      errors.push(`Task ${task.id} is part of a dependency cycle`);
    }
  }

  return errors;
}

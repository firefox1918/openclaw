/**
 * Task store - persistent task storage and management.
 *
 * Provides:
 * - CRUD operations for tasks
 * - Task claiming with atomic locks
 * - Event emission for task changes
 * - In-memory storage with optional persistence
 *
 * ## Integration Points
 *
 * 1. Task tool - creates and updates tasks through this store
 * 2. Dependency graph - called through store methods
 * 3. Agent run - claims tasks at start of execution
 */

import crypto from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  addDependency,
  getAllDependencies,
  getAllDependents,
  getBlockedTasks,
  getReadyTasks,
  removeDependency,
  resolveDependencies,
  updateStatusBasedOnBlockers,
} from "./dependency-graph.js";
import type {
  ClaimTaskResult,
  CreateTaskParams,
  Task,
  TaskQueryParams,
  TaskQueryResult,
  TaskStoreEvent,
  TaskStoreEventListener,
  UpdateTaskParams,
} from "./types.js";
import { isValidTaskStatus } from "./types.js";

const log = createSubsystemLogger("tasks/store");

// ============================================================================
// Task Store Implementation
// ============================================================================

/**
 * In-memory task store.
 */
export class TaskStore {
  private tasks: Map<string, Task> = new Map();
  private listeners: Set<TaskStoreEventListener> = new Set();
  private claimLocks: Map<string, { owner: string; claimedAt: number }> = new Map();

  /**
   * Create a new task.
   */
  create(params: CreateTaskParams): Task {
    const id = params.id || generateTaskId();
    const now = Date.now();

    const task: Task = {
      id,
      subject: params.subject,
      status: params.status || "pending",
      priority: params.priority || "medium",
      owner: null,
      ownerSessionKey: null,
      createdAt: now,
      updatedAt: now,
      blocks: [],
      blockedBy: [],
      description: params.description,
      metadata: params.metadata,
      parentTaskId: params.parentTaskId,
      deadline: params.deadline,
      tags: params.tags,
    };

    this.tasks.set(id, task);
    this.emit({ type: "created", task });

    log.info(`Created task ${id}: ${task.subject}`);
    return task;
  }

  /**
   * Get a task by ID.
   */
  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /**
   * Update a task.
   */
  update(id: string, params: UpdateTaskParams): Task | null {
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }

    const previousStatus = task.status;
    const previousOwner = task.owner;

    // Apply updates
    if (params.status !== undefined && isValidTaskStatus(params.status)) {
      task.status = params.status;
    }
    if (params.subject !== undefined) {
      task.subject = params.subject;
    }
    if (params.priority !== undefined) {
      task.priority = params.priority;
    }
    if (params.description !== undefined) {
      task.description = params.description;
    }
    if (params.metadata !== undefined) {
      task.metadata = { ...task.metadata, ...params.metadata };
    }
    if (params.deadline !== undefined) {
      task.deadline = params.deadline;
    }
    if (params.tags !== undefined) {
      task.tags = params.tags;
    }
    if (params.owner !== undefined) {
      task.owner = params.owner;
    }
    if (params.ownerSessionKey !== undefined) {
      task.ownerSessionKey = params.ownerSessionKey;
    }

    task.updatedAt = Date.now();

    // Handle status transitions
    if (task.status === "completed" && previousStatus !== "completed") {
      // Resolve dependencies when task completes
      resolveDependencies(this.tasks, id);
      this.emit({ type: "completed", task, previousStatus, previousOwner });
    } else {
      this.emit({ type: "updated", task, previousStatus, previousOwner });
    }

    log.info(`Updated task ${id}`);
    return task;
  }

  /**
   * Delete a task.
   */
  delete(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      return false;
    }

    // Remove all dependency relationships
    for (const blockerId of task.blockedBy) {
      const blocker = this.tasks.get(blockerId);
      if (blocker) {
        blocker.blocks = blocker.blocks.filter((b) => b !== id);
      }
    }
    for (const blockedId of task.blocks) {
      const blocked = this.tasks.get(blockedId);
      if (blocked) {
        blocked.blockedBy = blocked.blockedBy.filter((b) => b !== id);
        updateStatusBasedOnBlockers(this.tasks, blockedId);
      }
    }

    this.tasks.delete(id);
    this.claimLocks.delete(id);
    this.emit({ type: "deleted", task });

    log.info(`Deleted task ${id}`);
    return true;
  }

  /**
   * Claim a task for an agent.
   *
   * Atomic operation that:
   * 1. Checks if task exists
   * 2. Checks if task is already claimed
   * 3. Checks if task is blocked
   * 4. Sets owner and status to in_progress
   */
  claim(id: string, owner: string, sessionKey?: string): ClaimTaskResult {
    const task = this.tasks.get(id);

    if (!task) {
      return { success: false, error: "Task not found", reason: "not_found" };
    }

    if (task.status === "completed") {
      return { success: false, error: "Task already completed", reason: "completed" };
    }

    if (task.status === "cancelled") {
      return { success: false, error: "Task cancelled", reason: "cancelled" };
    }

    if (task.blockedBy.length > 0) {
      const pendingBlockers = task.blockedBy.filter((b) => {
        const blocker = this.tasks.get(b);
        return blocker?.status !== "completed" && blocker?.status !== "cancelled";
      });

      if (pendingBlockers.length > 0) {
        return {
          success: false,
          error: `Task blocked by: ${pendingBlockers.join(", ")}`,
          reason: "blocked",
        };
      }
    }

    if (task.owner) {
      // Check if lock is stale (older than 5 minutes)
      const lock = this.claimLocks.get(id);
      if (lock && Date.now() - lock.claimedAt < 300000) {
        return {
          success: false,
          error: `Task already claimed by ${task.owner}`,
          reason: "already_claimed",
        };
      }
    }

    // Claim the task
    const previousStatus = task.status;
    const previousOwner = task.owner;

    task.owner = owner;
    task.ownerSessionKey = sessionKey;
    task.status = "in_progress";
    task.updatedAt = Date.now();

    this.claimLocks.set(id, { owner, claimedAt: Date.now() });
    this.emit({ type: "claimed", task, previousStatus, previousOwner });

    log.info(`Task ${id} claimed by ${owner}`);
    return { success: true, task };
  }

  /**
   * Release a task claim.
   */
  release(id: string, owner: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) {
      return false;
    }

    const previousStatus = task.status;
    const previousOwner = task.owner;

    task.owner = null;
    task.ownerSessionKey = null;
    task.status = "pending";
    task.updatedAt = Date.now();

    this.claimLocks.delete(id);
    this.emit({ type: "released", task, previousStatus, previousOwner });

    log.info(`Task ${id} released by ${owner}`);
    return true;
  }

  /**
   * Add a dependency relationship.
   */
  addDependency(fromId: string, toId: string): boolean {
    const result = addDependency(this.tasks, fromId, toId);
    if (result) {
      updateStatusBasedOnBlockers(this.tasks, toId);
    }
    return result;
  }

  /**
   * Remove a dependency relationship.
   */
  removeDependency(fromId: string, toId: string): boolean {
    const result = removeDependency(this.tasks, fromId, toId);
    if (result) {
      updateStatusBasedOnBlockers(this.tasks, toId);
    }
    return result;
  }

  /**
   * Query tasks.
   */
  query(params?: TaskQueryParams): TaskQueryResult {
    let tasks = Array.from(this.tasks.values());

    // Filter by status
    if (params?.status) {
      const statuses = Array.isArray(params.status) ? params.status : [params.status];
      tasks = tasks.filter((t) => statuses.includes(t.status));
    }

    // Filter by owner
    if (params?.owner) {
      tasks = tasks.filter((t) => t.owner === params.owner);
    }

    // Filter by priority
    if (params?.priority) {
      const priorities = Array.isArray(params.priority) ? params.priority : [params.priority];
      tasks = tasks.filter((t) => priorities.includes(t.priority || "medium"));
    }

    // Filter by tags
    if (params?.tags && params.tags.length > 0) {
      tasks = tasks.filter((t) => params.tags!.some((tag) => t.tags?.includes(tag)));
    }

    // Filter by parent
    if (params?.parentTaskId) {
      tasks = tasks.filter((t) => t.parentTaskId === params.parentTaskId);
    }

    // Exclude blocked unless explicitly included
    if (!params?.includeBlocked) {
      tasks = tasks.filter((t) => t.status !== "blocked");
    }

    // Sort
    const sortBy = params?.sortBy || "createdAt";
    const direction = params?.sortDirection || "desc";

    tasks.sort((a, b) => {
      let comparison = 0;
      if (sortBy === "createdAt") {
        comparison = a.createdAt - b.createdAt;
      } else if (sortBy === "updatedAt") {
        comparison = a.updatedAt - b.updatedAt;
      } else if (sortBy === "priority") {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        comparison =
          (priorityOrder[a.priority || "medium"] || 2) -
          (priorityOrder[b.priority || "medium"] || 2);
      }
      return direction === "asc" ? comparison : -comparison;
    });

    const total = tasks.length;

    // Apply limit
    if (params?.limit) {
      tasks = tasks.slice(0, params.limit);
    }

    return { tasks, total };
  }

  /**
   * Get ready tasks (pending, no blockers).
   */
  getReadyTasks(): Task[] {
    return getReadyTasks(this.tasks);
  }

  /**
   * Get blocked tasks.
   */
  getBlockedTasks(): Task[] {
    return getBlockedTasks(this.tasks);
  }

  /**
   * Get all dependencies of a task.
   */
  getAllDependencies(taskId: string): string[] {
    return getAllDependencies(this.tasks, taskId);
  }

  /**
   * Get all dependents of a task.
   */
  getAllDependents(taskId: string): string[] {
    return getAllDependents(this.tasks, taskId);
  }

  /**
   * Add event listener.
   */
  addListener(listener: TaskStoreEventListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove event listener.
   */
  removeListener(listener: TaskStoreEventListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Emit an event.
   */
  private emit(event: TaskStoreEvent): void {
    for (const listener of this.listeners) {
      try {
        void listener(event);
      } catch (error) {
        log.error(`Event listener error: ${String(error)}`);
      }
    }
  }

  /**
   * Get all tasks.
   */
  getAll(): Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get task count.
   */
  count(): number {
    return this.tasks.size;
  }

  /**
   * Clear all tasks.
   */
  clear(): void {
    this.tasks.clear();
    this.claimLocks.clear();
    log.info("Task store cleared");
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a unique task ID.
 */
function generateTaskId(): string {
  return `task-${crypto.randomUUID().slice(0, 8)}`;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new task store.
 */
export function createTaskStore(): TaskStore {
  return new TaskStore();
}

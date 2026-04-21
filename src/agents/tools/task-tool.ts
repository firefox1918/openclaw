/**
 * Task management tool - provides task orchestration capabilities.
 *
 * This tool bridges the Hermes-style task management to OpenClaw.
 * Actions:
 * - create: Create a new task
 * - get: Get a task by ID
 * - update: Update a task
 * - delete: Delete a task
 * - list: List tasks (query)
 * - claim: Claim a task for execution
 * - release: Release a claimed task
 * - complete: Mark a task as completed
 * - add_dependency: Add a blocking dependency
 * - remove_dependency: Remove a dependency
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import { createTaskStore, type TaskStore } from "../tasks/store.js";
import type {
  ClaimTaskResult,
  CreateTaskParams,
  Task,
  TaskQueryParams,
  UpdateTaskParams,
} from "../tasks/types.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../tasks/types.js";
import { jsonResult } from "./common.js";

// ============================================================================
// Schema Definitions
// ============================================================================

const TaskCreateSchema = Type.Object({
  action: Type.Literal("create"),
  subject: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  status: Type.Optional(stringEnum(TASK_STATUSES)),
  priority: Type.Optional(stringEnum(TASK_PRIORITIES)),
  id: Type.Optional(Type.String()),
  deadline: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String())),
  parentTaskId: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const TaskGetSchema = Type.Object({
  action: Type.Literal("get"),
  id: Type.String(),
});

const TaskUpdateSchema = Type.Object({
  action: Type.Literal("update"),
  id: Type.String(),
  subject: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  description: Type.Optional(Type.String({ maxLength: 1000 })),
  status: Type.Optional(stringEnum(TASK_STATUSES)),
  priority: Type.Optional(stringEnum(TASK_PRIORITIES)),
  deadline: Type.Optional(Type.Number()),
  tags: Type.Optional(Type.Array(Type.String())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  owner: Type.Optional(Type.String()),
});

const TaskDeleteSchema = Type.Object({
  action: Type.Literal("delete"),
  id: Type.String(),
});

const TaskListSchema = Type.Object({
  action: Type.Literal("list"),
  status: Type.Optional(Type.Array(stringEnum(TASK_STATUSES))),
  owner: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Array(stringEnum(TASK_PRIORITIES))),
  tags: Type.Optional(Type.Array(Type.String())),
  parentTaskId: Type.Optional(Type.String()),
  sortBy: Type.Optional(stringEnum(["createdAt", "updatedAt", "priority"])),
  sortDirection: Type.Optional(stringEnum(["asc", "desc"])),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  includeBlocked: Type.Optional(Type.Boolean()),
});

const TaskClaimSchema = Type.Object({
  action: Type.Literal("claim"),
  id: Type.String(),
  owner: Type.String({ minLength: 1 }),
  sessionKey: Type.Optional(Type.String()),
});

const TaskReleaseSchema = Type.Object({
  action: Type.Literal("release"),
  id: Type.String(),
  owner: Type.String({ minLength: 1 }),
});

const TaskCompleteSchema = Type.Object({
  action: Type.Literal("complete"),
  id: Type.String(),
});

const TaskDependencySchema = Type.Object({
  action: Type.Literal("add_dependency"),
  fromId: Type.String(),
  toId: Type.String(),
});

const TaskRemoveDependencySchema = Type.Object({
  action: Type.Literal("remove_dependency"),
  fromId: Type.String(),
  toId: Type.String(),
});

const TaskGetReadySchema = Type.Object({
  action: Type.Literal("get_ready"),
});

const TaskGetBlockedSchema = Type.Object({
  action: Type.Literal("get_blocked"),
});

const TaskToolInputSchema = Type.Union([
  TaskCreateSchema,
  TaskGetSchema,
  TaskUpdateSchema,
  TaskDeleteSchema,
  TaskListSchema,
  TaskClaimSchema,
  TaskReleaseSchema,
  TaskCompleteSchema,
  TaskDependencySchema,
  TaskRemoveDependencySchema,
  TaskGetReadySchema,
  TaskGetBlockedSchema,
]);

type TaskToolInput = Static<typeof TaskToolInputSchema>;

// ============================================================================
// Task Tool Implementation
// ============================================================================

// Global task store instance (singleton)
let globalTaskStore: TaskStore | null = null;

function getTaskStore(): TaskStore {
  if (!globalTaskStore) {
    globalTaskStore = createTaskStore();
  }
  return globalTaskStore;
}

/**
 * Format a task for display.
 */
function formatTask(task: Task): string {
  const lines: string[] = [];
  lines.push(`Task: ${task.id}`);
  lines.push(`  Subject: ${task.subject}`);
  lines.push(`  Status: ${task.status}`);
  lines.push(`  Priority: ${task.priority || "medium"}`);
  if (task.owner) {
    lines.push(`  Owner: ${task.owner}`);
  }
  if (task.description) {
    lines.push(`  Description: ${task.description}`);
  }
  if (task.blockedBy.length > 0) {
    lines.push(`  Blocked by: ${task.blockedBy.join(", ")}`);
  }
  if (task.blocks.length > 0) {
    lines.push(`  Blocks: ${task.blocks.join(", ")}`);
  }
  if (task.tags && task.tags.length > 0) {
    lines.push(`  Tags: ${task.tags.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Format a list of tasks.
 */
function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "No tasks found.";
  }
  return tasks.map(formatTask).join("\n\n");
}

/**
 * Execute the task tool.
 */
async function executeTaskTool(
  toolCallId: string,
  input: TaskToolInput,
): Promise<AgentToolResult<unknown>> {
  const store = getTaskStore();

  switch (input.action) {
    case "create": {
      const params: CreateTaskParams = {
        id: input.id,
        subject: input.subject,
        description: input.description,
        status: input.status,
        priority: input.priority,
        deadline: input.deadline,
        tags: input.tags,
        parentTaskId: input.parentTaskId,
        metadata: input.metadata,
      };
      const task = store.create(params);
      return jsonResult({
        success: true,
        task,
        message: `Task created: ${task.id}`,
      });
    }

    case "get": {
      const task = store.get(input.id);
      if (!task) {
        return jsonResult({
          success: false,
          error: `Task not found: ${input.id}`,
        });
      }
      return jsonResult({
        success: true,
        task,
        formatted: formatTask(task),
      });
    }

    case "update": {
      const params: UpdateTaskParams = {
        subject: input.subject,
        description: input.description,
        status: input.status,
        priority: input.priority,
        deadline: input.deadline,
        tags: input.tags,
        metadata: input.metadata,
        owner: input.owner,
      };
      const task = store.update(input.id, params);
      if (!task) {
        return jsonResult({
          success: false,
          error: `Task not found: ${input.id}`,
        });
      }
      return jsonResult({
        success: true,
        task,
        message: `Task updated: ${task.id}`,
      });
    }

    case "delete": {
      const deleted = store.delete(input.id);
      return jsonResult({
        success: deleted,
        message: deleted ? `Task deleted: ${input.id}` : `Task not found: ${input.id}`,
      });
    }

    case "list": {
      const params: TaskQueryParams = {
        status: input.status as TaskQueryParams["status"],
        owner: input.owner,
        priority: input.priority as TaskQueryParams["priority"],
        tags: input.tags,
        parentTaskId: input.parentTaskId,
        sortBy: input.sortBy as TaskQueryParams["sortBy"],
        sortDirection: input.sortDirection as TaskQueryParams["sortDirection"],
        limit: input.limit,
        includeBlocked: input.includeBlocked,
      };
      const result = store.query(params);
      return jsonResult({
        success: true,
        tasks: result.tasks,
        total: result.total,
        formatted: formatTaskList(result.tasks),
      });
    }

    case "claim": {
      const result: ClaimTaskResult = store.claim(input.id, input.owner, input.sessionKey);
      if (result.success) {
        return jsonResult({
          success: true,
          task: result.task,
          message: `Task claimed: ${input.id} by ${input.owner}`,
        });
      }
      return jsonResult({
        success: false,
        error: result.error,
        reason: result.reason,
      });
    }

    case "release": {
      const released = store.release(input.id, input.owner);
      return jsonResult({
        success: released,
        message: released ? `Task released: ${input.id}` : `Failed to release task: ${input.id}`,
      });
    }

    case "complete": {
      const task = store.update(input.id, { status: "completed" });
      if (!task) {
        return jsonResult({
          success: false,
          error: `Task not found: ${input.id}`,
        });
      }
      return jsonResult({
        success: true,
        task,
        message: `Task completed: ${input.id}`,
      });
    }

    case "add_dependency": {
      const added = store.addDependency(input.fromId, input.toId);
      return jsonResult({
        success: added,
        message: added
          ? `Dependency added: ${input.fromId} blocks ${input.toId}`
          : `Failed to add dependency (cycle detected or task not found)`,
      });
    }

    case "remove_dependency": {
      const removed = store.removeDependency(input.fromId, input.toId);
      return jsonResult({
        success: removed,
        message: removed
          ? `Dependency removed: ${input.fromId} no longer blocks ${input.toId}`
          : `Failed to remove dependency`,
      });
    }

    case "get_ready": {
      const tasks = store.getReadyTasks();
      return jsonResult({
        success: true,
        tasks,
        formatted: formatTaskList(tasks),
        message: `${tasks.length} tasks ready to be claimed`,
      });
    }

    case "get_blocked": {
      const tasks = store.getBlockedTasks();
      return jsonResult({
        success: true,
        tasks,
        formatted: formatTaskList(tasks),
        message: `${tasks.length} tasks are blocked`,
      });
    }

    default:
      return jsonResult({
        success: false,
        error: `Unknown action: ${(input as { action: string }).action}`,
      });
  }
}

// ============================================================================
// Tool Creation
// ============================================================================

/**
 * Create the task management tool.
 */
export function createTaskTool() {
  return {
    name: "task",
    label: "task",
    description:
      "Manage tasks for orchestrating complex multi-step work. Actions: create, get, update, delete, list, claim, release, complete, add_dependency, remove_dependency, get_ready, get_blocked.",
    parameters: TaskToolInputSchema,
    execute: executeTaskTool,
  };
}

// ============================================================================
// Testing Exports
// ============================================================================

export const __testing = {
  getTaskStore,
  resetTaskStore(): void {
    globalTaskStore = null;
  },
  setTaskStore(store: TaskStore): void {
    globalTaskStore = store;
  },
};

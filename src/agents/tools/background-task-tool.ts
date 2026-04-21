/**
 * Background Task Tool - Claude Code's persistent background execution mechanism.
 *
 * This tool provides background task management capabilities for OpenClaw.
 * Actions:
 * - add: Add a new background task
 * - get: Get a task by ID
 * - list: List all background tasks
 * - cancel: Cancel a running task
 * - clear: Clear completed tasks
 * - stats: Get manager statistics
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import {
  BackgroundTasksManager,
  createBackgroundTasksManager,
  type BackgroundTaskConfig,
  type BackgroundTaskHandle,
} from "../background-tasks.js";
import { jsonResult } from "./common.js";

// ============================================================================
// Schema Definitions
// ============================================================================

const BackgroundTaskAddSchema = Type.Object({
  action: Type.Literal("add"),
  directive: Type.String({ minLength: 1, maxLength: 2000 }),
  timeout: Type.Optional(Type.Number({ minimum: 1000, maximum: 600000 })),
  retry: Type.Optional(Type.Boolean()),
  maxRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  sessionKey: Type.Optional(Type.String()),
  workspaceDir: Type.Optional(Type.String()),
});

const BackgroundTaskGetSchema = Type.Object({
  action: Type.Literal("get"),
  id: Type.String(),
});

const BackgroundTaskListSchema = Type.Object({
  action: Type.Literal("list"),
  status: Type.Optional(Type.Array(Type.String())),
});

const BackgroundTaskCancelSchema = Type.Object({
  action: Type.Literal("cancel"),
  id: Type.String(),
});

const BackgroundTaskClearSchema = Type.Object({
  action: Type.Literal("clear"),
});

const BackgroundTaskStatsSchema = Type.Object({
  action: Type.Literal("stats"),
});

const BackgroundTaskToolInputSchema = Type.Union([
  BackgroundTaskAddSchema,
  BackgroundTaskGetSchema,
  BackgroundTaskListSchema,
  BackgroundTaskCancelSchema,
  BackgroundTaskClearSchema,
  BackgroundTaskStatsSchema,
]);

type BackgroundTaskToolInput = Static<typeof BackgroundTaskToolInputSchema>;

// ============================================================================
// Background Task Tool Implementation
// ============================================================================

// Global background tasks manager instance (singleton)
let globalBackgroundTasksManager: BackgroundTasksManager | null = null;

function getBackgroundTasksManager(): BackgroundTasksManager {
  if (!globalBackgroundTasksManager) {
    globalBackgroundTasksManager = createBackgroundTasksManager({
      maxConcurrent: 5,
      defaultTimeout: 300000, // 5 minutes
      autoStart: true,
    });
    globalBackgroundTasksManager.start();
  }
  return globalBackgroundTasksManager;
}

/**
 * Format a background task for display.
 */
function formatBackgroundTask(task: BackgroundTaskHandle): string {
  const lines: string[] = [];
  lines.push(`Background Task: ${task.id}`);
  lines.push(`  Directive: ${task.config.directive}`);
  lines.push(`  Status: ${task.status}`);
  if (task.progress !== undefined) {
    lines.push(`  Progress: ${task.progress}%`);
  }
  if (task.message) {
    lines.push(`  Message: ${task.message}`);
  }
  if (task.startedAt) {
    lines.push(`  Started: ${new Date(task.startedAt).toISOString()}`);
  }
  if (task.completedAt) {
    lines.push(`  Completed: ${new Date(task.completedAt).toISOString()}`);
  }
  if (task.duration) {
    lines.push(`  Duration: ${task.duration}ms`);
  }
  if (task.result?.output) {
    lines.push(`  Output: ${task.result.output.slice(0, 200)}...`);
  }
  if (task.result?.error) {
    lines.push(`  Error: ${task.result.error}`);
  }
  return lines.join("\n");
}

/**
 * Format a list of background tasks.
 */
function formatBackgroundTaskList(tasks: BackgroundTaskHandle[]): string {
  if (tasks.length === 0) {
    return "No background tasks found.";
  }
  return tasks.map(formatBackgroundTask).join("\n\n");
}

/**
 * Execute the background task tool.
 */
async function executeBackgroundTaskTool(
  toolCallId: string,
  input: BackgroundTaskToolInput,
): Promise<AgentToolResult<unknown>> {
  const manager = getBackgroundTasksManager();

  switch (input.action) {
    case "add": {
      const config: BackgroundTaskConfig = {
        directive: input.directive,
        timeout: input.timeout,
        retry: input.retry,
        maxRetries: input.maxRetries,
        sessionKey: input.sessionKey,
        workspaceDir: input.workspaceDir,
      };
      const handle = manager.addTask(config);
      return jsonResult({
        success: true,
        task: handle,
        formatted: formatBackgroundTask(handle),
        message: `Background task added: ${handle.id}`,
      });
    }

    case "get": {
      const task = manager.getTask(input.id);
      if (!task) {
        return jsonResult({
          success: false,
          error: `Background task not found: ${input.id}`,
        });
      }
      return jsonResult({
        success: true,
        task,
        formatted: formatBackgroundTask(task),
      });
    }

    case "list": {
      const allTasks = manager.getAllTasks();
      let filtered = allTasks;

      if (input.status && input.status.length > 0) {
        filtered = allTasks.filter((t) => input.status!.includes(t.status));
      }

      return jsonResult({
        success: true,
        tasks: filtered,
        total: filtered.length,
        formatted: formatBackgroundTaskList(filtered),
      });
    }

    case "cancel": {
      const cancelled = manager.cancelTask(input.id);
      return jsonResult({
        success: cancelled,
        message: cancelled
          ? `Background task cancelled: ${input.id}`
          : `Failed to cancel task: ${input.id} (may already be completed)`,
      });
    }

    case "clear": {
      manager.clearCompleted();
      return jsonResult({
        success: true,
        message: "Completed background tasks cleared",
      });
    }

    case "stats": {
      const stats = manager.getStats();
      return jsonResult({
        success: true,
        stats,
        message: `Background tasks: ${stats.total} total, ${stats.pending} pending, ${stats.running} running, ${stats.completed} completed, ${stats.failed} failed, ${stats.cancelled} cancelled`,
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
 * Create the background task management tool.
 */
export function createBackgroundTaskTool() {
  return {
    name: "background_task",
    label: "background_task",
    description:
      "Manage background tasks that run persistently in the background. Actions: add, get, list, cancel, clear, stats. Background tasks continue running even after the main session ends.",
    parameters: BackgroundTaskToolInputSchema,
    execute: executeBackgroundTaskTool,
  };
}

// ============================================================================
// Testing Exports
// ============================================================================

export const __testing = {
  getBackgroundTasksManager,
  resetBackgroundTasksManager(): void {
    if (globalBackgroundTasksManager) {
      globalBackgroundTasksManager.stop();
      globalBackgroundTasksManager = null;
    }
  },
  setBackgroundTasksManager(manager: BackgroundTasksManager): void {
    globalBackgroundTasksManager = manager;
  },
};

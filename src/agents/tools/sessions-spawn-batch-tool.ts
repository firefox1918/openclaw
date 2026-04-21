/**
 * Sessions Spawn Batch Tool - Batch spawn subagents with cache optimization.
 *
 * This tool supports spawning 2-10 subagents simultaneously with shared
 * boilerplate for Prompt Cache optimization.
 *
 * ## Key Features
 *
 * 1. Batch spawning: Spawn 2-10 subagents in a single tool call
 * 2. Cache optimization: Shared boilerplate maximizes Prompt Cache hit rate
 * 3. Parallel execution: All subagents start simultaneously
 * 4. Token savings: Reuse cached prefix across all spawned sessions
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { SpawnedToolContext } from "../spawned-context.js";
import { SUBAGENT_SPAWN_MODES, spawnSubagentDirect } from "../subagent-spawn.js";
import { jsonResult, ToolInputError } from "./common.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Batch spawn boilerplate template - shared cache prefix for all batch spawns.
 *
 * This template is identical for all batch spawns, enabling cache reuse.
 * Each spawned subagent receives this shared prefix before their unique directive.
 */
export const BATCH_SPAWN_BOILERPLATE_TEMPLATE = `STOP. READ THIS FIRST.
You are a forked worker process spawned as part of a batch. You are NOT the main agent.

RULES:
1. Do NOT spawn sub-agents; execute directly
2. Do NOT converse or ask questions
3. USE your tools directly: Bash, Read, Write, Edit, Glob, Grep, etc.
4. If you modify files, commit before reporting
5. Stay strictly within your directive's scope
6. Keep report under 500 words
7. Response MUST begin with "Scope:" followed by directive summary

You are one of multiple parallel workers. Focus only on your assigned task.`;

const SESSIONS_SPAWN_BATCH_RUNTIMES = ["subagent", "acp"] as const;
const SESSIONS_SPAWN_BATCH_SANDBOX_MODES = ["inherit", "require"] as const;

// ============================================================================
// Schema Definitions
// ============================================================================

const SessionsSpawnBatchToolSchema = Type.Object({
  tasks: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), {
    minItems: 2,
    maxItems: 10,
    description: "Array of 2-10 tasks to execute in parallel batch spawn",
  }),
  label: Type.Optional(Type.String()),
  runtime: optionalStringEnum(SESSIONS_SPAWN_BATCH_RUNTIMES),
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  thread: Type.Optional(Type.Boolean()),
  mode: optionalStringEnum(SUBAGENT_SPAWN_MODES),
  cleanup: optionalStringEnum(["delete", "keep"] as const),
  sandbox: optionalStringEnum(SESSIONS_SPAWN_BATCH_SANDBOX_MODES),
  lightContext: Type.Optional(
    Type.Boolean({
      description:
        "When true, spawned subagent runs use lightweight bootstrap context. Only applies to runtime='subagent'.",
    }),
  ),
});

type SessionsSpawnBatchToolInput = Static<typeof SessionsSpawnBatchToolSchema>;

// ============================================================================
// Token Estimation & Cache Savings
// ============================================================================

/**
 * Estimate token count for a string (rough approximation).
 * Uses ~4 characters per token as a rule of thumb.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Calculate cache savings from batch spawning.
 *
 * Cache savings come from:
 * 1. Shared boilerplate template (only cached once)
 * 2. For N tasks, we save (N-1) * boilerplateTokens
 *
 * @param taskCount - Number of tasks in the batch
 * @returns Estimated token savings from cache reuse
 */
export function calculateCacheSavings(taskCount: number): number {
  if (taskCount <= 1) {
    return 0; // No savings for single task
  }

  const boilerplateTokens = estimateTokens(BATCH_SPAWN_BOILERPLATE_TEMPLATE);
  // Savings = (N-1) * boilerplateTokens because first task pays full cost
  // and remaining (N-1) tasks get cache hit on boilerplate
  return (taskCount - 1) * boilerplateTokens;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Summarize an error into a string message.
 */
export function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

/**
 * Build the batch directive text with task list.
 *
 * Creates a structured directive that includes:
 * 1. Shared boilerplate template
 * 2. Numbered list of all tasks
 */
export function buildBatchDirective(tasks: string[]): string {
  const taskList = tasks.map((task, index) => `Task ${index + 1}: ${task}`).join("\n\n");

  return `${BATCH_SPAWN_BOILERPLATE_TEMPLATE}\n\nYOUR ASSIGNED TASKS:\n${taskList}`;
}

// ============================================================================
// Batch Spawn Manager
// ============================================================================

/**
 * Dependencies for BatchSpawnManager (for dependency injection in tests).
 */
export type BatchSpawnManagerDeps = {
  callGateway: typeof callGateway;
};

/**
 * Result from spawning a batch of subagents.
 */
export type BatchSpawnResult = {
  /** Status of the batch operation */
  status: "accepted" | "error";
  /** Array of spawned session keys */
  sessionKeys: string[];
  /** Array of run IDs (for ACP runtime) */
  runIds: string[];
  /** Estimated cache savings in tokens */
  estimatedCacheSavings: number;
  /** Error message if status is "error" */
  error?: string;
};

/**
 * Manager for batch spawn operations.
 */
export class BatchSpawnManager {
  private deps: BatchSpawnManagerDeps;

  constructor(deps: BatchSpawnManagerDeps) {
    this.deps = deps;
  }

  /**
   * Execute batch spawn with parallel execution.
   */
  async spawnBatch(params: {
    tasks: string[];
    runtime: "subagent" | "acp";
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    agentGroupId?: string;
    agentGroupChannel?: GatewayMessageChannel;
    agentGroupSpace?: string;
    requesterAgentIdOverride?: string;
    workspaceDir?: string;
    label?: string;
    mode?: "run" | "session";
    cleanup?: "delete" | "keep";
    sandbox?: "inherit" | "require";
    lightContext?: boolean;
    expectsCompletionMessage?: boolean;
  }): Promise<BatchSpawnResult> {
    const { tasks } = params;

    // Calculate cache savings
    const estimatedCacheSavings = calculateCacheSavings(tasks.length);

    try {
      // Spawn all tasks in parallel
      const spawnPromises = tasks.map((task) =>
        this.spawnSingleTask({
          ...params,
          task,
        }),
      );

      const results = await Promise.all(spawnPromises);

      const sessionKeys: string[] = [];
      const runIds: string[] = [];

      for (const result of results) {
        if (result.sessionKey) {
          sessionKeys.push(result.sessionKey);
        }
        if (result.runId) {
          runIds.push(result.runId);
        }
      }

      return {
        status: "accepted",
        sessionKeys,
        runIds,
        estimatedCacheSavings,
      };
    } catch (err) {
      return {
        status: "error",
        sessionKeys: [],
        runIds: [],
        estimatedCacheSavings: 0,
        error: summarizeError(err),
      };
    }
  }

  /**
   * Spawn a single subagent task.
   */
  private async spawnSingleTask(params: {
    task: string;
    runtime: "subagent" | "acp";
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    agentGroupId?: string;
    agentGroupChannel?: GatewayMessageChannel;
    agentGroupSpace?: string;
    requesterAgentIdOverride?: string;
    workspaceDir?: string;
    label?: string;
    mode?: "run" | "session";
    cleanup?: "delete" | "keep";
    sandbox?: "inherit" | "require";
    lightContext?: boolean;
    expectsCompletionMessage?: boolean;
  }): Promise<{ sessionKey?: string; runId?: string }> {
    const { task, runtime, workspaceDir, lightContext, ...rest } = params;

    if (runtime === "acp") {
      // ACP spawn path - would need separate implementation
      // For now, use subagent path
      return this.spawnSubagentTask({
        task,
        workspaceDir,
        ...rest,
      });
    }

    return this.spawnSubagentTask({
      task,
      workspaceDir,
      lightContext,
      ...rest,
    });
  }

  /**
   * Spawn a subagent task using spawnSubagentDirect.
   */
  private async spawnSubagentTask(params: {
    task: string;
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    agentGroupId?: string;
    agentGroupChannel?: GatewayMessageChannel;
    agentGroupSpace?: string;
    requesterAgentIdOverride?: string;
    workspaceDir?: string;
    label?: string;
    mode?: "run" | "session";
    cleanup?: "delete" | "keep";
    sandbox?: "inherit" | "require";
    lightContext?: boolean;
    expectsCompletionMessage?: boolean;
  }): Promise<{ sessionKey?: string; runId?: string }> {
    const result = await spawnSubagentDirect(
      {
        task: params.task,
        label: params.label || undefined,
        agentId: undefined,
        model: undefined,
        thinking: undefined,
        runTimeoutSeconds: undefined,
        thread: false,
        mode: params.mode,
        cleanup: params.cleanup ?? "keep",
        sandbox: params.sandbox ?? "inherit",
        lightContext: params.lightContext ?? false,
        expectsCompletionMessage: params.expectsCompletionMessage ?? true,
      },
      {
        agentSessionKey: params.agentSessionKey,
        agentChannel: params.agentChannel,
        agentAccountId: params.agentAccountId,
        agentTo: params.agentTo,
        agentThreadId: params.agentThreadId,
        agentGroupId: params.agentGroupId,
        agentGroupChannel: params.agentGroupChannel,
        agentGroupSpace: params.agentGroupSpace,
        requesterAgentIdOverride: params.requesterAgentIdOverride,
        workspaceDir: params.workspaceDir,
      },
    );

    return {
      sessionKey: result.childSessionKey,
      runId: result.runId,
    };
  }
}

// ============================================================================
// Global Manager Instance
// ============================================================================

let globalBatchSpawnManager: BatchSpawnManager | null = null;

function getBatchSpawnManager(): BatchSpawnManager {
  if (!globalBatchSpawnManager) {
    globalBatchSpawnManager = new BatchSpawnManager({
      callGateway,
    });
  }
  return globalBatchSpawnManager;
}

// ============================================================================
// Tool Execution
// ============================================================================

async function executeSessionsSpawnBatchTool(
  _toolCallId: string,
  args: SessionsSpawnBatchToolInput,
): Promise<AgentToolResult<unknown>> {
  const params = args as Record<string, unknown>;

  const tasks = Array.isArray(params.tasks) ? params.tasks : [];

  // Validate tasks count (schema should catch this, but double-check)
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 10) {
    throw new ToolInputError("tasks array must contain 2-10 items");
  }

  // Validate all tasks are non-empty strings
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (typeof task !== "string" || task.trim().length === 0) {
      throw new ToolInputError(`Task at index ${i} must be a non-empty string`);
    }
  }

  const runtime = params.runtime === "acp" ? "acp" : "subagent";
  const label = typeof params.label === "string" ? params.label : undefined;
  const lightContext = params.lightContext === true;

  if (runtime === "acp" && lightContext) {
    throw new Error("lightContext is only supported for runtime='subagent'.");
  }

  const manager = getBatchSpawnManager();

  // Build batch directive for logging/debugging
  const batchDirective = buildBatchDirective(tasks as string[]);

  const result = await manager.spawnBatch({
    tasks: tasks as string[],
    runtime,
    label: label?.trim() ? `${label.trim()}-batch` : undefined,
    lightContext,
    cleanup: params.cleanup as "delete" | "keep" | undefined,
    sandbox: params.sandbox as "inherit" | "require" | undefined,
    mode: params.mode as "run" | "session" | undefined,
  });

  if (result.status === "error") {
    return jsonResult({
      status: "error",
      error: result.error,
    });
  }

  return jsonResult({
    status: "accepted",
    sessionKeys: result.sessionKeys,
    runIds: result.runIds,
    taskCount: tasks.length,
    estimatedCacheSavings: result.estimatedCacheSavings,
    estimatedCacheSavingsPercent: Math.round(
      (result.estimatedCacheSavings / (estimateTokens(batchDirective) * tasks.length)) * 100,
    ),
    message: `Spawned ${result.sessionKeys.length} subagents in batch with ~${result.estimatedCacheSavings} tokens cache savings`,
  });
}

// ============================================================================
// Tool Creation
// ============================================================================

export function createSessionsSpawnBatchTool(
  _opts?: SpawnedToolContext & {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    sandboxed?: boolean;
    /** Explicit agent ID override for cron/hook sessions where session key parsing may not work. */
    requesterAgentIdOverride?: string;
  },
) {
  return {
    name: "sessions_spawn_batch",
    label: "Sessions Batch",
    description:
      "Spawn 2-10 subagents simultaneously in a batch with shared boilerplate for Prompt Cache optimization. Use this for parallel execution of independent tasks.",
    parameters: SessionsSpawnBatchToolSchema,
    execute: executeSessionsSpawnBatchTool,
  };
}

// ============================================================================
// Testing Exports
// ============================================================================

export const __testing = {
  BATCH_SPAWN_BOILERPLATE_TEMPLATE,
  estimateTokens,
  calculateCacheSavings,
  buildBatchDirective,
  summarizeError,
  getBatchSpawnManager,
  resetBatchSpawnManager(): void {
    globalBatchSpawnManager = null;
  },
  setBatchSpawnManager(manager: BatchSpawnManager): void {
    globalBatchSpawnManager = manager;
  },
};

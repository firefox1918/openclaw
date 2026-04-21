/**
 * Streaming Tool Executor - Claude Code's core innovation for parallel execution.
 *
 * Key innovation: Execute tools while still streaming, maximizing concurrency.
 *
 * ## Concept (Claude Code 12-Layer Harness S02)
 *
 * Traditional: Wait for all tool_calls → Execute sequentially
 * StreamingToolExecutor: Add tool → Immediately try to execute (if concurrency-safe)
 *
 * ## Concurrency Strategy
 *
 * | Tool Type       | Strategy                      | Examples           |
 * |-----------------|-------------------------------|--------------------|
 * | Concurrency-safe| Parallel (max 10)             | Read, Glob, Grep   |
 * | Non-safe        | Strict sequential             | Edit, Write, Bash  |
 * | Mixed           | Batch read → Batch write      | Search → Modify    |
 *
 * ## Integration Points
 *
 * 1. pi-embedded-runner/run.ts - Use in main loop
 * 2. tools/common.ts - isConcurrencySafe() method
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("streaming-executor");

// ============================================================================
// Types
// ============================================================================

/**
 * Tool execution status.
 */
export type ToolExecutionStatus = "queued" | "executing" | "completed" | "failed" | "yielded";

/**
 * A tracked tool in the execution queue.
 */
export interface TrackedTool {
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Current status */
  status: ToolExecutionStatus;
  /** Whether tool is concurrency-safe (can run in parallel) */
  isConcurrencySafe: boolean;
  /** Result when completed */
  result?: unknown;
  /** Error if failed */
  error?: string;
  /** When tool was added */
  addedAt: number;
  /** When tool execution started */
  startedAt?: number;
  /** When tool execution completed */
  completedAt?: number;
}

/**
 * Tool executor function type.
 */
export type ToolExecutorFn = (
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Progress callback type.
 */
export type ProgressCallback = (
  toolId: string,
  status: ToolExecutionStatus,
  result?: unknown,
) => void;

/**
 * Configuration for StreamingToolExecutor.
 */
export interface StreamingExecutorConfig {
  /** Maximum concurrent tools (default: 10) */
  maxConcurrent?: number;
  /** Timeout for each tool (default: 120000ms) */
  toolTimeout?: number;
  /** Whether to auto-process queue on add (default: true) */
  autoProcess?: boolean;
  /** Tool names that are concurrency-safe */
  concurrencySafeTools?: Set<string>;
  /** Tool names that are strictly sequential */
  sequentialTools?: Set<string>;
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Tools that are safe to run in parallel (read-only operations).
 */
const DEFAULT_CONCURRENCY_SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "LS",
  "TaskGet",
  "TaskList",
  "TaskGetReady",
  "TaskGetBlocked",
  "SkillsQuery",
  "SessionsList",
  "AgentsList",
  "Gateway",
]);

/**
 * Tools that must run sequentially (write/execute operations).
 */
const DEFAULT_SEQUENTIAL_TOOLS = new Set([
  "Edit",
  "Write",
  "Bash",
  "Process",
  "TaskCreate",
  "TaskUpdate",
  "TaskDelete",
  "TaskClaim",
  "TaskComplete",
  "TaskAddDependency",
  "SkillManage",
  "SessionsSpawn",
  "SessionsSend",
  "Message",
]);

// ============================================================================
// StreamingToolExecutor Implementation
// ============================================================================

/**
 * Streaming Tool Executor - executes tools with intelligent concurrency.
 *
 * Claude Code's core innovation: start executing tools while still streaming.
 */
export class StreamingToolExecutor {
  private tools: TrackedTool[] = [];
  private executor: ToolExecutorFn;
  private progressCallback?: ProgressCallback;
  private config: StreamingExecutorConfig;
  private processing = false;

  constructor(
    executor: ToolExecutorFn,
    config?: StreamingExecutorConfig,
    progressCallback?: ProgressCallback,
  ) {
    this.executor = executor;
    this.progressCallback = progressCallback;
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 10,
      toolTimeout: config?.toolTimeout ?? 120000,
      autoProcess: config?.autoProcess ?? true,
      concurrencySafeTools: config?.concurrencySafeTools ?? DEFAULT_CONCURRENCY_SAFE_TOOLS,
      sequentialTools: config?.sequentialTools ?? DEFAULT_SEQUENTIAL_TOOLS,
    };
  }

  /**
   * Add a tool to the execution queue.
   *
   * This is called during streaming when a tool_use block is received.
   * Immediately attempts to process the queue if autoProcess is enabled.
   */
  addTool(toolCallId: string, name: string, input: Record<string, unknown>): TrackedTool {
    const isConcurrencySafe = this.checkConcurrencySafety(name);
    const tool: TrackedTool = {
      id: toolCallId,
      name,
      input,
      status: "queued",
      isConcurrencySafe,
      addedAt: Date.now(),
    };

    this.tools.push(tool);
    log.info(`Added tool ${name} (${toolCallId}), concurrency-safe: ${isConcurrencySafe}`);

    // Auto-process queue (streaming innovation: start executing immediately)
    if (this.config.autoProcess) {
      void this.processQueue();
    }

    return tool;
  }

  /**
   * Check if a tool is concurrency-safe.
   */
  private checkConcurrencySafety(name: string): boolean {
    // Explicit sequential tools are never concurrency-safe
    if (this.config.sequentialTools!.has(name)) {
      return false;
    }
    // Explicit concurrency-safe tools
    if (this.config.concurrencySafeTools!.has(name)) {
      return true;
    }
    // Default: unknown tools are treated as sequential (safe default)
    return false;
  }

  /**
   * Check if a tool can be executed now.
   */
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter((t) => t.status === "executing");
    const executingCount = executing.length;

    // No tools executing - can start any tool
    if (executingCount === 0) {
      return true;
    }

    // At max concurrency - cannot start more
    if (executingCount >= this.config.maxConcurrent!) {
      return false;
    }

    // Concurrency-safe tool can run if all executing tools are also safe
    if (isConcurrencySafe) {
      return executing.every((t) => t.isConcurrencySafe);
    }

    // Non-safe tool must wait for all tools to complete
    return false;
  }

  /**
   * Process the execution queue.
   *
   * This is the core logic that determines which tools can run.
   */
  async processQueue(): Promise<void> {
    // Prevent double-processing
    if (this.processing) {
      return;
    }
    this.processing = true;

    try {
      const queuedTools = this.tools.filter((t) => t.status === "queued");

      for (const tool of queuedTools) {
        if (this.canExecuteTool(tool.isConcurrencySafe)) {
          // Execute this tool
          void this.executeTool(tool);
        } else if (!tool.isConcurrencySafe) {
          // Non-concurrency-safe tool blocks the queue
          // Wait for executing tools to complete before continuing
          break;
        }
        // Concurrency-safe tool skipped (max concurrency reached)
        // Will be picked up when executing tools complete
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Execute a single tool.
   */
  private async executeTool(tool: TrackedTool): Promise<void> {
    tool.status = "executing";
    tool.startedAt = Date.now();
    this.notifyProgress(tool);

    log.info(`Executing tool ${tool.name} (${tool.id})`);

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(tool);
      tool.status = "completed";
      tool.result = result;
      tool.completedAt = Date.now();
      log.info(`Tool ${tool.name} (${tool.id}) completed`);
    } catch (error) {
      tool.status = "failed";
      tool.error = error instanceof Error ? error.message : String(error);
      tool.completedAt = Date.now();
      log.error(`Tool ${tool.name} (${tool.id}) failed: ${tool.error}`);
    }

    this.notifyProgress(tool);

    // Trigger next tool processing
    void this.processQueue();
  }

  /**
   * Execute tool with timeout.
   */
  private async executeWithTimeout(tool: TrackedTool): Promise<unknown> {
    const timeoutMs = this.config.toolTimeout!;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool execution timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([this.executor(tool.id, tool.name, tool.input), timeoutPromise]);
  }

  /**
   * Notify progress callback.
   */
  private notifyProgress(tool: TrackedTool): void {
    if (this.progressCallback) {
      this.progressCallback(tool.id, tool.status, tool.result);
    }
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get a tool by ID.
   */
  getTool(toolId: string): TrackedTool | undefined {
    return this.tools.find((t) => t.id === toolId);
  }

  /**
   * Get all tools.
   */
  getAllTools(): TrackedTool[] {
    return [...this.tools];
  }

  /**
   * Get executing tools.
   */
  getExecutingTools(): TrackedTool[] {
    return this.tools.filter((t) => t.status === "executing");
  }

  /**
   * Get completed tools.
   */
  getCompletedTools(): TrackedTool[] {
    return this.tools.filter((t) => t.status === "completed" || t.status === "failed");
  }

  /**
   * Get queued tools.
   */
  getQueuedTools(): TrackedTool[] {
    return this.tools.filter((t) => t.status === "queued");
  }

  /**
   * Check if all tools are complete.
   */
  isComplete(): boolean {
    return this.tools.every(
      (t) => t.status === "completed" || t.status === "failed" || t.status === "yielded",
    );
  }

  /**
   * Wait for all tools to complete.
   */
  async waitForAll(): Promise<TrackedTool[]> {
    while (!this.isComplete()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.tools;
  }

  /**
   * Wait for a specific tool to complete.
   */
  async waitForTool(toolId: string): Promise<TrackedTool> {
    const tool = this.getTool(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }

    while (tool.status !== "completed" && tool.status !== "failed" && tool.status !== "yielded") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return tool;
  }

  /**
   * Get results for all completed tools.
   */
  getResults(): Map<string, unknown> {
    const results = new Map<string, unknown>();
    for (const tool of this.tools) {
      if (tool.status === "completed" && tool.result !== undefined) {
        results.set(tool.id, tool.result);
      }
    }
    return results;
  }

  /**
   * Clear completed tools (for memory management).
   */
  clearCompleted(): void {
    this.tools = this.tools.filter((t) => t.status !== "completed" && t.status !== "failed");
  }

  /**
   * Reset executor (clear all tools).
   */
  reset(): void {
    this.tools = [];
    this.processing = false;
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a StreamingToolExecutor.
 */
export function createStreamingToolExecutor(
  executor: ToolExecutorFn,
  config?: StreamingExecutorConfig,
  progressCallback?: ProgressCallback,
): StreamingToolExecutor {
  return new StreamingToolExecutor(executor, config, progressCallback);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a tool name is concurrency-safe using default rules.
 */
export function isConcurrencySafeTool(name: string): boolean {
  return DEFAULT_CONCURRENCY_SAFE_TOOLS.has(name);
}

/**
 * Check if a tool name is sequential using default rules.
 */
export function isSequentialTool(name: string): boolean {
  return DEFAULT_SEQUENTIAL_TOOLS.has(name);
}

/**
 * Get the concurrency category for a tool.
 */
export function getToolConcurrencyCategory(name: string): "safe" | "sequential" | "unknown" {
  if (DEFAULT_CONCURRENCY_SAFE_TOOLS.has(name)) {
    return "safe";
  }
  if (DEFAULT_SEQUENTIAL_TOOLS.has(name)) {
    return "sequential";
  }
  return "unknown";
}

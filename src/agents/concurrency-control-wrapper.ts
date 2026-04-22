import { copyPluginToolMeta } from "../plugins/tools.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

/**
 * Maximum number of concurrent tool executions allowed.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * List of tools that are safe to execute concurrently.
 * These tools can run in parallel up to maxConcurrent limit.
 */
export const CONCURRENCY_SAFE_TOOLS = ["read", "grep", "glob", "web-fetch", "web-search"] as const;

export type ConcurrencySafeToolName = (typeof CONCURRENCY_SAFE_TOOLS)[number];

/**
 * Interface for managing concurrency slots for tool execution.
 */
export interface ConcurrencySlotManager {
  /**
   * Acquire a slot for tool execution.
   * Blocks until a slot is available if at maxConcurrent.
   * @param toolCallId - Unique identifier for this tool call
   * @param toolName - Name of the tool being executed
   * @param signal - Optional abort signal to cancel waiting
   * @returns Promise that resolves when slot is acquired
   */
  acquireSlot(toolCallId: string, toolName: string, signal?: AbortSignal): Promise<void>;

  /**
   * Release a slot after tool execution completes.
   * @param toolCallId - The tool call identifier to release
   */
  releaseSlot(toolCallId: string): void;

  /**
   * Get current slot manager status.
   * @returns Status object with active/queued counts
   */
  getStatus(): {
    activeCount: number;
    queuedCount: number;
    maxConcurrent: number;
  };
}

interface QueuedRequest {
  toolCallId: string;
  toolName: string;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SlotInfo {
  toolCallId: string;
  toolName: string;
  abortController?: AbortController;
}

interface ConcurrencySlotManagerOptions {
  maxConcurrent?: number;
}

/**
 * Creates a new ConcurrencySlotManager instance.
 */
export function createConcurrencySlotManager(
  options: ConcurrencySlotManagerOptions = {},
): ConcurrencySlotManager {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const activeSlots = new Map<string, SlotInfo>();
  const queue: QueuedRequest[] = [];

  function processQueue(): void {
    // Process queued requests in FIFO order while slots are available
    while (queue.length > 0 && activeSlots.size < maxConcurrent) {
      const next = queue.shift();
      if (!next) {
        break;
      }

      // Check if signal was aborted while waiting
      if (next.signal?.aborted) {
        const error = new Error("Aborted");
        (error as Error & { name: string }).name = "AbortError";
        next.reject(error);
        continue;
      }

      // Acquire the slot
      const slotInfo: SlotInfo = {
        toolCallId: next.toolCallId,
        toolName: next.toolName,
      };
      activeSlots.set(next.toolCallId, slotInfo);
      next.resolve();
    }
  }

  function setupAbortHandling(request: QueuedRequest): void {
    if (!request.signal) {
      return;
    }

    const onAbort = () => {
      // Remove from queue if still waiting
      const index = queue.findIndex((q) => q.toolCallId === request.toolCallId);
      if (index !== -1) {
        queue.splice(index, 1);
      }

      const error = new Error("Aborted");
      (error as Error & { name: string }).name = "AbortError";
      request.reject(error);
    };

    request.signal.addEventListener("abort", onAbort, { once: true });
  }

  async function acquireSlot(
    toolCallId: string,
    toolName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Check if already aborted
    if (signal?.aborted) {
      const error = new Error("Aborted");
      (error as Error & { name: string }).name = "AbortError";
      throw error;
    }

    // Check if slots available
    if (activeSlots.size < maxConcurrent) {
      const slotInfo: SlotInfo = {
        toolCallId,
        toolName,
      };
      activeSlots.set(toolCallId, slotInfo);
      return;
    }

    // Need to wait for a slot
    return new Promise<void>((resolve, reject) => {
      const request: QueuedRequest = {
        toolCallId,
        toolName,
        signal,
        resolve,
        reject,
      };

      setupAbortHandling(request);
      queue.push(request);
    });
  }

  function releaseSlot(toolCallId: string): void {
    const slotInfo = activeSlots.get(toolCallId);
    if (!slotInfo) {
      // Slot not found - may have already been released
      return;
    }

    activeSlots.delete(toolCallId);

    // Process any queued requests
    processQueue();
  }

  function getStatus(): { activeCount: number; queuedCount: number; maxConcurrent: number } {
    return {
      activeCount: activeSlots.size,
      queuedCount: queue.length,
      maxConcurrent,
    };
  }

  return {
    acquireSlot,
    releaseSlot,
    getStatus,
  };
}

/**
 * Wraps a tool with concurrency control.
 * The wrapper acquires a slot before execution and releases it after completion.
 */
export function wrapToolWithConcurrencyControl(
  tool: AnyAgentTool,
  slotManager: ConcurrencySlotManager,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }

  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // Acquire slot before execution
      await slotManager.acquireSlot(toolCallId, tool.name, signal);

      try {
        return await execute(toolCallId, params, signal, onUpdate);
      } finally {
        // Always release slot on success, error, or abort
        slotManager.releaseSlot(toolCallId);
      }
    },
  };

  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);

  return wrappedTool;
}

/**
 * Test isolation utilities.
 */
export const __testing = {
  /**
   * Clears all slots and queue for test isolation.
   * Only use in test setup/teardown.
   */
  clearAllSlots(manager: ConcurrencySlotManager): void {
    // This is a hack for test isolation - in production,
    // slots should be properly released through releaseSlot
    const internalManager = manager as unknown as {
      activeSlots?: Map<string, SlotInfo>;
      queue?: QueuedRequest[];
    };
    if (internalManager.activeSlots) {
      internalManager.activeSlots.clear();
    }
    if (internalManager.queue) {
      internalManager.queue.length = 0;
    }
  },
} as const;

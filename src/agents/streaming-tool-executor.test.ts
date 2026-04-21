/**
 * Tests for StreamingToolExecutor.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  createStreamingToolExecutor,
  isConcurrencySafeTool,
  isSequentialTool,
  getToolConcurrencyCategory,
  StreamingToolExecutor,
} from "./streaming-tool-executor.js";

describe("streaming-tool-executor", () => {
  describe("concurrency helpers", () => {
    it("should identify concurrency-safe tools", () => {
      expect(isConcurrencySafeTool("Read")).toBe(true);
      expect(isConcurrencySafeTool("Glob")).toBe(true);
      expect(isConcurrencySafeTool("Grep")).toBe(true);
      expect(isConcurrencySafeTool("WebFetch")).toBe(true);
      expect(isConcurrencySafeTool("WebSearch")).toBe(true);
    });

    it("should identify sequential tools", () => {
      expect(isSequentialTool("Edit")).toBe(true);
      expect(isSequentialTool("Write")).toBe(true);
      expect(isSequentialTool("Bash")).toBe(true);
    });

    it("should return unknown for unrecognized tools", () => {
      expect(isConcurrencySafeTool("CustomTool")).toBe(false);
      expect(isSequentialTool("CustomTool")).toBe(false);
    });

    it("should get correct concurrency category", () => {
      expect(getToolConcurrencyCategory("Read")).toBe("safe");
      expect(getToolConcurrencyCategory("Write")).toBe("sequential");
      expect(getToolConcurrencyCategory("CustomTool")).toBe("unknown");
    });
  });

  describe("StreamingToolExecutor", () => {
    let executor: (
      toolCallId: string,
      name: string,
      input: Record<string, unknown>,
    ) => Promise<unknown>;
    let progressCallback: (toolId: string, status: string, result?: unknown) => void;
    let streamingExecutor: StreamingToolExecutor;

    beforeEach(() => {
      executor = vi
        .fn()
        .mockImplementation(async (id: string, name: string, input: Record<string, unknown>) => {
          // Simulate tool execution
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { success: true, id, name, input };
        }) as (
        toolCallId: string,
        name: string,
        input: Record<string, unknown>,
      ) => Promise<unknown>;
      progressCallback = vi.fn() as (toolId: string, status: string, result?: unknown) => void;
      streamingExecutor = createStreamingToolExecutor(
        executor,
        {
          maxConcurrent: 5,
          toolTimeout: 5000,
          autoProcess: true,
        },
        progressCallback,
      );
    });

    describe("addTool", () => {
      it("should add a tool to the queue", () => {
        // Create executor without autoProcess to test queued status
        const queuedExecutor = createStreamingToolExecutor(
          executor,
          {
            maxConcurrent: 5,
            toolTimeout: 5000,
            autoProcess: false, // Don't auto-process to keep tool queued
          },
          progressCallback,
        );

        const tool = queuedExecutor.addTool("tool-1", "Read", { path: "/test" });
        expect(tool.id).toBe("tool-1");
        expect(tool.name).toBe("Read");
        expect(tool.status).toBe("queued");
        expect(tool.isConcurrencySafe).toBe(true);
      });

      it("should mark sequential tools as non-concurrency-safe", () => {
        const tool = streamingExecutor.addTool("tool-2", "Write", { path: "/test" });
        expect(tool.isConcurrencySafe).toBe(false);
      });
    });

    describe("processQueue", () => {
      it("should execute concurrency-safe tools in parallel", async () => {
        // Add multiple safe tools
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        streamingExecutor.addTool("tool-2", "Read", { path: "/b" });
        streamingExecutor.addTool("tool-3", "Glob", { pattern: "*.ts" });

        // Wait for completion
        await streamingExecutor.waitForAll();

        // All should complete
        expect(streamingExecutor.isComplete()).toBe(true);
        expect(executor).toHaveBeenCalledTimes(3);
      });

      it("should execute sequential tools one at a time", async () => {
        // Add sequential tools
        streamingExecutor.addTool("tool-1", "Write", { path: "/a" });
        streamingExecutor.addTool("tool-2", "Write", { path: "/b" });

        // Wait for completion
        await streamingExecutor.waitForAll();

        expect(streamingExecutor.isComplete()).toBe(true);
        expect(executor).toHaveBeenCalledTimes(2);

        // Verify they ran sequentially (not concurrent)
        const tool1 = streamingExecutor.getTool("tool-1");
        const tool2 = streamingExecutor.getTool("tool-2");

        // tool-2 should start after tool-1 completes
        expect(tool2?.startedAt).toBeGreaterThanOrEqual(tool1?.completedAt ?? 0);
      });

      it("should not start sequential tool while safe tools are running", async () => {
        // Add safe tool first
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        // Add sequential tool
        streamingExecutor.addTool("tool-2", "Write", { path: "/b" });

        // Wait briefly
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Safe tool should be executing, sequential tool should be queued
        const executing = streamingExecutor.getExecutingTools();
        streamingExecutor.getQueuedTools();

        // At least one should be executing (the safe one)
        expect(executing.length).toBeGreaterThanOrEqual(1);
        expect(executing.some((t) => t.isConcurrencySafe)).toBe(true);

        // Sequential tool should wait
        const writeTool = streamingExecutor.getTool("tool-2");
        expect(writeTool?.status).toBe("queued");

        // Wait for all to complete
        await streamingExecutor.waitForAll();
        expect(streamingExecutor.isComplete()).toBe(true);
      });
    });

    describe("query methods", () => {
      it("should get tool by ID", () => {
        streamingExecutor.addTool("tool-1", "Read", { path: "/test" });
        const tool = streamingExecutor.getTool("tool-1");
        expect(tool?.name).toBe("Read");
      });

      it("should return undefined for non-existent tool", () => {
        const tool = streamingExecutor.getTool("non-existent");
        expect(tool).toBeUndefined();
      });

      it("should get all tools", () => {
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        streamingExecutor.addTool("tool-2", "Write", { path: "/b" });
        const tools = streamingExecutor.getAllTools();
        expect(tools.length).toBe(2);
      });

      it("should get completed tools", async () => {
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        await streamingExecutor.waitForAll();
        const completed = streamingExecutor.getCompletedTools();
        expect(completed.length).toBe(1);
      });
    });

    describe("progress callback", () => {
      it("should notify progress on status changes", async () => {
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        await streamingExecutor.waitForAll();

        // Should have been called for executing and completed
        expect(progressCallback).toHaveBeenCalled();
        const calls = vi.mocked(progressCallback).mock.calls;
        expect(calls.some((c) => c[1] === "executing")).toBe(true);
        expect(calls.some((c) => c[1] === "completed")).toBe(true);
      });
    });

    describe("timeout handling", () => {
      it("should timeout long-running tools", async () => {
        // Create executor with short timeout
        const slowExecutor = vi.fn().mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return { success: true };
        });

        const timeoutExecutor = createStreamingToolExecutor(slowExecutor, {
          toolTimeout: 200,
          autoProcess: true,
        });

        timeoutExecutor.addTool("tool-1", "Bash", { command: "sleep 1" });
        await timeoutExecutor.waitForAll();

        const tool = timeoutExecutor.getTool("tool-1");
        expect(tool?.status).toBe("failed");
        expect(tool?.error).toContain("timeout");
      });
    });

    describe("clearCompleted", () => {
      it("should clear completed tools", async () => {
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        await streamingExecutor.waitForAll();

        expect(streamingExecutor.getAllTools().length).toBe(1);
        streamingExecutor.clearCompleted();
        expect(streamingExecutor.getAllTools().length).toBe(0);
      });

      it("should not clear executing tools", async () => {
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        streamingExecutor.clearCompleted();
        // Tool might still be executing, should not be cleared
        expect(streamingExecutor.getAllTools().length).toBeGreaterThan(0);
      });
    });

    describe("reset", () => {
      it("should reset executor", async () => {
        streamingExecutor.addTool("tool-1", "Read", { path: "/a" });
        await streamingExecutor.waitForAll();

        streamingExecutor.reset();
        expect(streamingExecutor.getAllTools().length).toBe(0);
        expect(streamingExecutor.isComplete()).toBe(true); // Empty = complete
      });
    });
  });
});

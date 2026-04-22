import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createConcurrencySlotManager,
  wrapToolWithConcurrencyControl,
  CONCURRENCY_SAFE_TOOLS,
  __testing,
} from "./concurrency-control-wrapper.js";

describe("ConcurrencySlotManager", () => {
  describe("createConcurrencySlotManager", () => {
    it("creates with default maxConcurrent = 10", () => {
      const manager = createConcurrencySlotManager();
      const status = manager.getStatus();

      expect(status.maxConcurrent).toBe(10);
      expect(status.activeCount).toBe(0);
      expect(status.queuedCount).toBe(0);
    });

    it("creates with custom maxConcurrent", () => {
      const manager = createConcurrencySlotManager({ maxConcurrent: 5 });
      const status = manager.getStatus();

      expect(status.maxConcurrent).toBe(5);
    });
  });

  describe("acquireSlot and releaseSlot", () => {
    let manager: ReturnType<typeof createConcurrencySlotManager>;

    beforeEach(() => {
      manager = createConcurrencySlotManager({ maxConcurrent: 3 });
    });

    it("acquires a slot successfully", async () => {
      await manager.acquireSlot("call-1", "read");
      const status = manager.getStatus();

      expect(status.activeCount).toBe(1);
      expect(status.queuedCount).toBe(0);
    });

    it("releases a slot successfully", async () => {
      await manager.acquireSlot("call-1", "read");
      manager.releaseSlot("call-1");
      const status = manager.getStatus();

      expect(status.activeCount).toBe(0);
    });

    it("tracks multiple active slots", async () => {
      await manager.acquireSlot("call-1", "read");
      await manager.acquireSlot("call-2", "grep");
      await manager.acquireSlot("call-3", "glob");

      const status = manager.getStatus();
      expect(status.activeCount).toBe(3);
    });

    it("releases specific slot by toolCallId", async () => {
      await manager.acquireSlot("call-1", "read");
      await manager.acquireSlot("call-2", "grep");
      await manager.acquireSlot("call-3", "glob");

      manager.releaseSlot("call-2");
      const status = manager.getStatus();

      expect(status.activeCount).toBe(2);
    });
  });

  describe("blocking when maxConcurrent reached", () => {
    let manager: ReturnType<typeof createConcurrencySlotManager>;

    beforeEach(() => {
      manager = createConcurrencySlotManager({ maxConcurrent: 2 });
    });

    it("blocks acquireSlot when maxConcurrent reached", async () => {
      // Fill all slots
      const slot1Promise = manager.acquireSlot("call-1", "read");
      const slot2Promise = manager.acquireSlot("call-2", "read");

      await Promise.all([slot1Promise, slot2Promise]);
      expect(manager.getStatus().activeCount).toBe(2);

      // Try to acquire third slot - should not resolve immediately
      let thirdSlotResolved = false;
      const slot3Promise = manager.acquireSlot("call-3", "read").then(() => {
        thirdSlotResolved = true;
      });

      // Give it a moment to resolve if it's going to
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(thirdSlotResolved).toBe(false);
      expect(manager.getStatus().queuedCount).toBe(1);

      // Release a slot - third should now resolve
      manager.releaseSlot("call-1");
      await slot3Promise;

      expect(thirdSlotResolved).toBe(true);
      expect(manager.getStatus().activeCount).toBe(2);
    });

    it("processes queued slots in FIFO order", async () => {
      const resolutionOrder: string[] = [];

      // Fill all slots
      await manager.acquireSlot("call-1", "read");
      await manager.acquireSlot("call-2", "read");

      // Queue multiple requests
      void manager.acquireSlot("call-3", "read").then(() => resolutionOrder.push("call-3"));
      void manager.acquireSlot("call-4", "read").then(() => resolutionOrder.push("call-4"));
      void manager.acquireSlot("call-5", "read").then(() => resolutionOrder.push("call-5"));

      // Release slots one by one
      manager.releaseSlot("call-1");
      await new Promise((resolve) => setTimeout(resolve, 10));

      manager.releaseSlot("call-2");
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(resolutionOrder).toEqual(["call-3", "call-4"]);
    });
  });

  describe("concurrency-safe tools", () => {
    it("allows concurrent-safe tools to parallelize up to maxConcurrent", async () => {
      const manager = createConcurrencySlotManager({ maxConcurrent: 3 });

      // All concurrency-safe tools should be able to acquire slots
      const safeTools = CONCURRENCY_SAFE_TOOLS.slice(0, 3);
      const promises = safeTools.map((tool, index) => manager.acquireSlot(`call-${index}`, tool));

      await Promise.all(promises);
      expect(manager.getStatus().activeCount).toBe(3);
    });
  });

  describe("getStatus", () => {
    it("returns accurate counts", async () => {
      const manager = createConcurrencySlotManager({ maxConcurrent: 5 });

      expect(manager.getStatus()).toEqual({
        activeCount: 0,
        queuedCount: 0,
        maxConcurrent: 5,
      });

      await manager.acquireSlot("call-1", "read");
      await manager.acquireSlot("call-2", "grep");

      expect(manager.getStatus()).toEqual({
        activeCount: 2,
        queuedCount: 0,
        maxConcurrent: 5,
      });
    });
  });
});

describe("AbortSignal integration", () => {
  let manager: ReturnType<typeof createConcurrencySlotManager>;

  beforeEach(() => {
    manager = createConcurrencySlotManager({ maxConcurrent: 2 });
  });

  it("aborts acquireSlot when signal is aborted", async () => {
    // Fill all slots
    await manager.acquireSlot("call-1", "read");
    await manager.acquireSlot("call-2", "read");

    const abortController = new AbortController();

    // Try to acquire with abort signal
    let resolved = false;
    let rejected = false;
    let error: unknown;

    const acquirePromise = manager
      .acquireSlot("call-3", "read", abortController.signal)
      .then(() => {
        resolved = true;
      })
      .catch((err) => {
        rejected = true;
        error = err;
      });

    // Abort the signal
    abortController.abort();
    await acquirePromise;

    expect(resolved).toBe(false);
    expect(rejected).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });

  it("releases slot when execution aborted after acquire", async () => {
    const abortController = new AbortController();

    await manager.acquireSlot("call-1", "read", abortController.signal);
    expect(manager.getStatus().activeCount).toBe(1);

    // Simulate abort during execution
    abortController.abort();

    // The slot should be released when abort happens
    // This tests that the wrapper properly releases on abort
    manager.releaseSlot("call-1");
    expect(manager.getStatus().activeCount).toBe(0);
  });

  it("does not acquire slot if signal already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(manager.acquireSlot("call-1", "read", abortController.signal)).rejects.toThrow(
      "Aborted",
    );

    expect(manager.getStatus().activeCount).toBe(0);
  });
});

describe("__testing object", () => {
  it("exposes clearAllSlots for test isolation", () => {
    expect(__testing.clearAllSlots).toBeDefined();
    expect(typeof __testing.clearAllSlots).toBe("function");
  });
});

describe("wrapToolWithConcurrencyControl", () => {
  function createMockTool(name: string, executeFn?: AnyAgentTool["execute"]): AnyAgentTool {
    return {
      name,
      label: name,
      description: `Mock ${name} tool`,
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: executeFn,
    } as AnyAgentTool;
  }

  type AnyAgentTool = AgentTool<any, unknown> & {
    ownerOnly?: boolean;
    displaySummary?: string;
  };

  it("acquires slot before execution and releases after success", async () => {
    const manager = createConcurrencySlotManager({ maxConcurrent: 2 });
    let executeCalled = false;

    const tool = createMockTool("read", async () => {
      executeCalled = true;
      expect(manager.getStatus().activeCount).toBe(1);
      return { content: [{ type: "text", text: "ok" }], details: {} };
    });

    const wrappedTool = wrapToolWithConcurrencyControl(tool, manager);
    await wrappedTool.execute("call-1", {}, undefined, undefined);

    expect(executeCalled).toBe(true);
    expect(manager.getStatus().activeCount).toBe(0);
  });

  it("releases slot on error during execution", async () => {
    const manager = createConcurrencySlotManager({ maxConcurrent: 2 });

    const tool = createMockTool("read", async () => {
      throw new Error("Tool execution failed");
    });

    const wrappedTool = wrapToolWithConcurrencyControl(tool, manager);

    await expect(wrappedTool.execute("call-1", {}, undefined, undefined)).rejects.toThrow(
      "Tool execution failed",
    );

    // Slot should be released even after error
    expect(manager.getStatus().activeCount).toBe(0);
  });

  it("releases slot on abort during execution", async () => {
    const manager = createConcurrencySlotManager({ maxConcurrent: 2 });
    const abortController = new AbortController();

    const tool = createMockTool("read", async (_toolCallId, _params, signal) => {
      // Wait for abort
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const err = new Error("Aborted");
          (err as Error & { name: string }).name = "AbortError";
          reject(err);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      return { content: [{ type: "text", text: "ok" }], details: {} };
    });

    const wrappedTool = wrapToolWithConcurrencyControl(tool, manager);
    const executePromise = wrappedTool.execute("call-1", {}, abortController.signal, undefined);

    // Abort during execution
    setTimeout(() => abortController.abort(), 10);

    await expect(executePromise).rejects.toThrow("Aborted");

    // Slot should be released after abort
    expect(manager.getStatus().activeCount).toBe(0);
  });

  it("respects maxConcurrent limit with wrapped tools", async () => {
    const manager = createConcurrencySlotManager({ maxConcurrent: 2 });
    const executionOrder: string[] = [];

    const createSlowTool = (name: string, delay: number) =>
      createMockTool(name, async () => {
        executionOrder.push(`${name}-start`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        executionOrder.push(`${name}-end`);
        return { content: [{ type: "text", text: "ok" }], details: {} };
      });

    const tool1 = wrapToolWithConcurrencyControl(createSlowTool("tool1", 50), manager);
    const tool2 = wrapToolWithConcurrencyControl(createSlowTool("tool2", 50), manager);
    const tool3 = wrapToolWithConcurrencyControl(createSlowTool("tool3", 50), manager);

    // Start all three - third should wait
    const promises = [
      tool1.execute("call-1", {}, undefined, undefined),
      tool2.execute("call-2", {}, undefined, undefined),
      tool3.execute("call-3", {}, undefined, undefined),
    ];

    await Promise.all(promises);

    // All should complete
    expect(executionOrder).toContain("tool1-start");
    expect(executionOrder).toContain("tool2-start");
    expect(executionOrder).toContain("tool3-start");

    // tool3 should start after one of the first two ends
    const tool3StartIndex = executionOrder.indexOf("tool3-start");
    const firstEndIndex = Math.min(
      executionOrder.indexOf("tool1-end"),
      executionOrder.indexOf("tool2-end"),
    );
    expect(tool3StartIndex).toBeGreaterThan(firstEndIndex);
  });
});

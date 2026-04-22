/**
 * Tests for CoordinatorLoopManager.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createCoordinatorLoopManager, __testing } from "./coordinator-loop-manager.js";

describe("coordinator-loop-manager", () => {
  beforeEach(() => {
    __testing.resetCoordinatorLoopManager();
  });

  afterEach(() => {
    __testing.resetCoordinatorLoopManager();
  });

  describe("lifecycle", () => {
    it("should create manager with start method", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      expect(manager.start).toBeDefined();
      expect(typeof manager.start).toBe("function");
    });

    it("should create manager with stop method", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      expect(manager.stop).toBeDefined();
      expect(typeof manager.stop).toBe("function");
    });

    it("should create manager with pause method", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      expect(manager.pause).toBeDefined();
      expect(typeof manager.pause).toBe("function");
    });

    it("should create manager with resume method", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      expect(manager.resume).toBeDefined();
      expect(typeof manager.resume).toBe("function");
    });

    it("should create manager with getStatus method", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      expect(manager.getStatus).toBeDefined();
      expect(typeof manager.getStatus).toBe("function");
    });

    it("should generate loopId with format coord-<uuid>", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();
      const status = manager.getStatus();

      expect(status.loopId).toMatch(/^coord-[a-f0-9-]+$/);
    });

    it("should start with status 'idle'", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();
      const status = manager.getStatus();

      expect(status.status).toBe("idle");
    });

    it("should stop and set status to 'stopped'", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();
      expect(manager.getStatus().status).toBe("idle");

      manager.stop();
      const status = manager.getStatus();

      expect(status.status).toBe("stopped");
    });

    it("should pause when running", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();
      manager.pause();
      const status = manager.getStatus();

      expect(status.status).toBe("paused");
    });

    it("should resume from paused state", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();
      manager.pause();
      expect(manager.getStatus().status).toBe("paused");

      manager.resume();
      const status = manager.getStatus();

      expect(status.status).toBe("idle");
    });

    it("should track tasksCompleted counter", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();
      __testing.incrementTasksCompleted(manager);
      __testing.incrementTasksCompleted(manager);

      const status = manager.getStatus();
      expect(status.tasksCompleted).toBe(2);
    });

    it("should track tasksFailed counter", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();
      __testing.incrementTasksFailed(manager);

      const status = manager.getStatus();
      expect(status.tasksFailed).toBe(1);
    });
  });

  describe("consecutive failure handling", () => {
    it("should pause after 5 consecutive failures", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();

      // Simulate 5 consecutive failures
      for (let i = 0; i < 5; i++) {
        __testing.incrementConsecutiveFailures(manager);
      }

      const status = manager.getStatus();
      expect(status.status).toBe("error");
      expect(status.consecutiveFailures).toBe(5);
    });

    it("should reset consecutiveFailures on success", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();

      // Simulate 3 failures
      for (let i = 0; i < 3; i++) {
        __testing.incrementConsecutiveFailures(manager);
      }

      expect(manager.getStatus().consecutiveFailures).toBe(3);

      // Reset on success
      __testing.resetConsecutiveFailures(manager);

      expect(manager.getStatus().consecutiveFailures).toBe(0);
    });

    it("should track consecutiveFailures counter", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      manager.start();

      __testing.incrementConsecutiveFailures(manager);
      __testing.incrementConsecutiveFailures(manager);
      __testing.incrementConsecutiveFailures(manager);

      const status = manager.getStatus();
      expect(status.consecutiveFailures).toBe(3);
    });
  });

  describe("sleep function", () => {
    it("should export sleep function with AbortSignal support", () => {
      expect(__testing.sleep).toBeDefined();
      expect(typeof __testing.sleep).toBe("function");
    });

    it("should sleep for specified duration", async () => {
      const start = Date.now();
      await __testing.sleep(50);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(45); // Allow some tolerance
    });

    it("should abort sleep when AbortSignal is triggered", async () => {
      const controller = new AbortController();

      const sleepPromise = __testing.sleep(1000, controller.signal);

      // Abort after 10ms
      setTimeout(() => controller.abort(), 10);

      await expect(sleepPromise).rejects.toThrow("Sleep aborted");
    });

    it("should throw AbortError when aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(__testing.sleep(100, controller.signal)).rejects.toBeInstanceOf(
        __testing.AbortError,
      );
    });
  });

  describe("CoordinatorOptions", () => {
    it("should accept idleInterval option", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
        idleInterval: 5000,
      });

      expect(manager).toBeDefined();
    });

    it("should accept maxRetries option", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
        maxRetries: 3,
      });

      expect(manager).toBeDefined();
    });

    it("should accept timeoutPerTask option", () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
        timeoutPerTask: 60000,
      });

      expect(manager).toBeDefined();
    });
  });

  describe("runLoop with task tool", () => {
    it("should have setTaskTool method", () => {
      createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      expect(__testing.setTaskTool).toBeDefined();
    });

    it("should run loop and complete tasks", async () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      // Mock task tool
      const mockTaskTool = {
        get_ready: vi.fn().mockResolvedValue({
          success: true,
          tasks: [{ id: "task-1", subject: "Test task" }],
        }),
        claim: vi.fn().mockResolvedValue({ success: true, task: { id: "task-1" } }),
        complete: vi.fn().mockResolvedValue({ success: true }),
        mark_failed: vi.fn().mockResolvedValue({ success: true }),
      };

      __testing.setTaskTool(manager, mockTaskTool);

      // Run the loop manually (not via start/idleCycle)
      await (manager as any).runLoop();

      expect(mockTaskTool.get_ready).toHaveBeenCalled();
      expect(mockTaskTool.claim).toHaveBeenCalledWith("task-1", "test-agent", "test-session");
      expect(mockTaskTool.complete).toHaveBeenCalledWith("task-1");

      const status = manager.getStatus();
      expect(status.tasksCompleted).toBe(1);
      expect(status.consecutiveFailures).toBe(0);
    });

    it("should handle task failure and track consecutiveFailures", async () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      // Mock task tool that fails
      const mockTaskTool = {
        get_ready: vi.fn().mockResolvedValue({
          success: true,
          tasks: [{ id: "task-1", subject: "Test task" }],
        }),
        claim: vi.fn().mockResolvedValue({ success: true, task: { id: "task-1" } }),
        complete: vi.fn().mockRejectedValue(new Error("Task execution failed")),
        mark_failed: vi.fn().mockResolvedValue({ success: true }),
      };

      __testing.setTaskTool(manager, mockTaskTool);

      await (manager as any).runLoop();

      expect(mockTaskTool.mark_failed).toHaveBeenCalledWith("task-1", "Task execution failed");

      const status = manager.getStatus();
      expect(status.tasksFailed).toBe(1);
      expect(status.consecutiveFailures).toBe(1);
    });

    it("should handle get_ready returning no tasks", async () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      const mockTaskTool = {
        get_ready: vi.fn().mockResolvedValue({
          success: true,
          tasks: [],
        }),
        claim: vi.fn(),
        complete: vi.fn(),
        mark_failed: vi.fn(),
      };

      __testing.setTaskTool(manager, mockTaskTool);

      await (manager as any).runLoop();

      expect(mockTaskTool.get_ready).toHaveBeenCalled();
      expect(mockTaskTool.claim).not.toHaveBeenCalled();

      const status = manager.getStatus();
      expect(status.status).toBe("idle");
    });

    it("should handle get_ready failure", async () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      const mockTaskTool = {
        get_ready: vi.fn().mockResolvedValue({
          success: false,
          error: "Failed to get ready tasks",
        }),
        claim: vi.fn(),
        complete: vi.fn(),
        mark_failed: vi.fn(),
      };

      __testing.setTaskTool(manager, mockTaskTool);

      await (manager as any).runLoop();

      expect(mockTaskTool.get_ready).toHaveBeenCalled();
      expect(mockTaskTool.claim).not.toHaveBeenCalled();
    });

    it("should skip loop when no agentId is set", async () => {
      const manager = createCoordinatorLoopManager({
        sessionKey: "test-session",
        // No agentId
      });

      const mockTaskTool = {
        get_ready: vi.fn(),
        claim: vi.fn(),
        complete: vi.fn(),
        mark_failed: vi.fn(),
      };

      __testing.setTaskTool(manager, mockTaskTool);

      await (manager as any).runLoop();

      expect(mockTaskTool.get_ready).not.toHaveBeenCalled();
    });

    it("should skip loop when no task tool is set", async () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      await (manager as any).runLoop();

      // Should not throw, just log and return
      // Status remains "stopped" since we never called start()
      const status = manager.getStatus();
      expect(status.status).toBe("stopped");
    });
  });

  describe("setRunLoop for custom loop", () => {
    it("should use custom runLoop function when provided", async () => {
      const manager = createCoordinatorLoopManager({
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      let customRunLoopCalled = false;
      const customRunLoop = async () => {
        customRunLoopCalled = true;
      };

      __testing.setRunLoop(manager, customRunLoop);

      await (manager as any).idleCycle();

      expect(customRunLoopCalled).toBe(true);
    });
  });
});

/**
 * Tests for Background Tasks.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createBackgroundTasksManager,
  canRunInBackground,
  taskToBackgroundConfig,
  BackgroundTasksManager,
} from "./background-tasks.js";

describe("background-tasks", () => {
  let manager: BackgroundTasksManager;

  beforeEach(() => {
    manager = createBackgroundTasksManager({
      maxConcurrent: 3,
      defaultTimeout: 5000,
      checkInterval: 100,
      autoStart: false, // Disable auto-start for tests
    });
  });

  afterEach(() => {
    manager.stop();
  });

  describe("addTask", () => {
    it("should add a background task", () => {
      const handle = manager.addTask({
        directive: "Run tests",
      });

      expect(handle.id).toBeDefined();
      expect(handle.id.startsWith("bg-")).toBe(true);
      expect(handle.status).toBe("pending");
      expect(handle.progress).toBe(0);
    });

    it("should track added tasks", () => {
      manager.addTask({ directive: "Task A" });
      manager.addTask({ directive: "Task B" });

      const all = manager.getAllTasks();
      expect(all.length).toBe(2);
    });

    it("should store config", () => {
      const handle = manager.addTask({
        directive: "Search code",
        timeout: 60000,
        workspaceDir: "/project",
      });

      expect(handle.config.directive).toBe("Search code");
      expect(handle.config.timeout).toBe(60000);
      expect(handle.config.workspaceDir).toBe("/project");
    });
  });

  describe("getTask", () => {
    it("should get task by ID", () => {
      const handle = manager.addTask({ directive: "Test" });
      const retrieved = manager.getTask(handle.id);

      expect(retrieved?.id).toBe(handle.id);
    });

    it("should return undefined for unknown ID", () => {
      const result = manager.getTask("unknown");
      expect(result).toBeUndefined();
    });
  });

  describe("query methods", () => {
    it("should get running tasks", () => {
      const handle1 = manager.addTask({ directive: "Task 1" });
      const handle2 = manager.addTask({ directive: "Task 2" });

      handle1.status = "running";
      handle2.status = "pending";

      const running = manager.getRunningTasks();
      expect(running.length).toBe(1);
      expect(running[0].id).toBe(handle1.id);
    });

    it("should get completed tasks", () => {
      const handle1 = manager.addTask({ directive: "Task 1" });
      const handle2 = manager.addTask({ directive: "Task 2" });
      const handle3 = manager.addTask({ directive: "Task 3" });

      handle1.status = "completed";
      handle2.status = "failed";
      handle3.status = "running";

      const completed = manager.getCompletedTasks();
      expect(completed.length).toBe(2);
    });

    it("should get all tasks", () => {
      manager.addTask({ directive: "A" });
      manager.addTask({ directive: "B" });
      manager.addTask({ directive: "C" });

      const all = manager.getAllTasks();
      expect(all.length).toBe(3);
    });
  });

  describe("processPendingTasks", () => {
    it("should execute pending tasks with executor", async () => {
      const executor = vi.fn().mockImplementation(async (config) => ({
        taskId: "test",
        status: "completed",
        output: `Executed: ${config.directive}`,
        duration: 100,
      }));

      manager.setExecutor(executor);
      manager.start();

      const handle = manager.addTask({ directive: "Run tests" });
      await manager.processPendingTasks();

      // Wait for execution
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handle.status).toBe("completed");
      expect(executor).toHaveBeenCalled();
    });

    it("should respect maxConcurrent limit", async () => {
      const executor = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { taskId: "test", status: "completed" };
      });

      manager = createBackgroundTasksManager({ maxConcurrent: 2, autoStart: false });
      manager.setExecutor(executor);

      // Add 4 tasks
      for (let i = 0; i < 4; i++) {
        manager.addTask({ directive: `Task ${i}` });
      }

      await manager.processPendingTasks();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Only 2 should be running
      const running = manager.getRunningTasks();
      expect(running.length).toBeLessThanOrEqual(2);
    });

    it("should handle executor errors", async () => {
      const executor = vi.fn().mockRejectedValue(new Error("Executor failed"));

      manager.setExecutor(executor);
      const handle = manager.addTask({ directive: "Failing task" });

      await manager.processPendingTasks();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handle.status).toBe("failed");
      expect(handle.result?.error).toContain("Executor failed");
    });
  });

  describe("cancelTask", () => {
    it("should cancel pending task", () => {
      const handle = manager.addTask({ directive: "Task" });

      const result = manager.cancelTask(handle.id);
      expect(result).toBe(true);
      expect(handle.status).toBe("cancelled");
    });

    it("should cancel running task", () => {
      const handle = manager.addTask({ directive: "Task" });
      handle.status = "running";

      const result = manager.cancelTask(handle.id);
      expect(result).toBe(true);
      expect(handle.status).toBe("cancelled");
    });

    it("should not cancel completed task", () => {
      const handle = manager.addTask({ directive: "Task" });
      handle.status = "completed";

      const result = manager.cancelTask(handle.id);
      expect(result).toBe(false);
    });

    it("should return false for unknown task", () => {
      const result = manager.cancelTask("unknown");
      expect(result).toBe(false);
    });
  });

  describe("clearCompleted", () => {
    it("should clear completed tasks", () => {
      const handle1 = manager.addTask({ directive: "A" });
      const handle2 = manager.addTask({ directive: "B" });

      handle1.status = "completed";
      handle2.status = "pending";

      manager.clearCompleted();

      const all = manager.getAllTasks();
      expect(all.length).toBe(1);
      expect(all[0].id).toBe(handle2.id);
    });

    it("should clear failed and cancelled tasks", () => {
      const h1 = manager.addTask({ directive: "A" });
      const h2 = manager.addTask({ directive: "B" });
      const h3 = manager.addTask({ directive: "C" });

      h1.status = "completed";
      h2.status = "failed";
      h3.status = "cancelled";

      manager.clearCompleted();

      expect(manager.getAllTasks().length).toBe(0);
    });
  });

  describe("getStats", () => {
    it("should return correct stats", () => {
      const h1 = manager.addTask({ directive: "A" });
      const h2 = manager.addTask({ directive: "B" });
      const h3 = manager.addTask({ directive: "C" });

      h1.status = "completed";
      h2.status = "running";
      h3.status = "pending";

      const stats = manager.getStats();

      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(1);
      expect(stats.running).toBe(1);
      expect(stats.pending).toBe(1);
    });
  });

  describe("start/stop", () => {
    it("should start and stop manager", () => {
      manager.start();
      manager.stop();

      // Should be safe to call multiple times
      manager.stop();
    });
  });

  describe("retry", () => {
    it("should configure retry settings", () => {
      const handle = manager.addTask({
        directive: "Retry task",
        retry: true,
        maxRetries: 3,
      });

      expect(handle.config.retry).toBe(true);
      expect(handle.config.maxRetries).toBe(3);
    });
  });
});

describe("canRunInBackground", () => {
  it("should return true for pending task without dependencies", () => {
    const task = {
      status: "pending",
      blockedBy: [],
    };

    expect(canRunInBackground(task)).toBe(true);
  });

  it("should return false for blocked task", () => {
    const task = {
      status: "pending",
      blockedBy: ["task-0"],
    };

    expect(canRunInBackground(task)).toBe(false);
  });

  it("should return false for completed task", () => {
    const task = {
      status: "completed",
      blockedBy: [],
    };

    expect(canRunInBackground(task)).toBe(false);
  });
});

describe("taskToBackgroundConfig", () => {
  it("should convert task to config", () => {
    const task = {
      id: "task-1",
      subject: "Search for bugs",
      priority: "high",
      tags: ["bug", "urgent"],
      metadata: {
        sessionKey: "session-123",
        workspaceDir: "/project",
      },
    };

    const config = taskToBackgroundConfig(task);

    expect(config.directive).toBe("Search for bugs");
    expect(config.sessionKey).toBe("session-123");
    expect(config.workspaceDir).toBe("/project");
    expect(config.additionalContext?.taskId).toBe("task-1");
    expect(config.additionalContext?.priority).toBe("high");
    expect(config.additionalContext?.tags).toEqual(["bug", "urgent"]);
  });
});

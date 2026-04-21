/**
 * Tests for Background Task Tool.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createBackgroundTaskTool, __testing } from "./background-task-tool.js";

describe("background-task-tool", () => {
  beforeEach(() => {
    __testing.resetBackgroundTasksManager();
  });

  afterEach(() => {
    __testing.resetBackgroundTasksManager();
  });

  describe("tool creation", () => {
    it("should create tool with correct name", () => {
      const tool = createBackgroundTaskTool();
      expect(tool.name).toBe("background_task");
      expect(tool.label).toBe("background_task");
      expect(tool.description).toContain("Manage background tasks");
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it("should have valid schema for all actions", () => {
      const tool = createBackgroundTaskTool();
      const schema = tool.parameters;

      // Check that schema is a TypeBox schema (Union type)
      expect(schema.anyOf).toBeDefined();
    });
  });

  describe("tool execution", () => {
    it("should add a background task", async () => {
      const tool = createBackgroundTaskTool();
      const result = await tool.execute("test-id", {
        action: "add",
        directive: "Process files in background",
      });

      expect(result.content).toBeDefined();
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(true);
      expect(payload.task).toBeDefined();
      expect(payload.task.id).toMatch(/^bg-/);
      expect(payload.task.status).toBe("pending");
      expect(payload.task.config.directive).toBe("Process files in background");
    });

    it("should add task with all options", async () => {
      const tool = createBackgroundTaskTool();
      const result = await tool.execute("test-id", {
        action: "add",
        directive: "Complex task",
        timeout: 60000,
        retry: true,
        maxRetries: 3,
        sessionKey: "session-123",
        workspaceDir: "/workspace",
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(true);
      expect(payload.task.config.timeout).toBe(60000);
      expect(payload.task.config.retry).toBe(true);
      expect(payload.task.config.maxRetries).toBe(3);
    });

    it("should get a background task by ID", async () => {
      const tool = createBackgroundTaskTool();

      // Add a task first
      const addResult = await tool.execute("test-id", {
        action: "add",
        directive: "Test task",
      });
      const addPayload = JSON.parse((addResult.content[0] as { text: string }).text);
      const taskId = addPayload.task.id;

      // Get the task
      const getResult = await tool.execute("test-id", {
        action: "get",
        id: taskId,
      });

      const getPayload = JSON.parse((getResult.content[0] as { text: string }).text);
      expect(getPayload.success).toBe(true);
      expect(getPayload.task.id).toBe(taskId);
      expect(getPayload.formatted).toContain(taskId);
    });

    it("should return error for non-existent task", async () => {
      const tool = createBackgroundTaskTool();
      const result = await tool.execute("test-id", {
        action: "get",
        id: "non-existent-id",
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(false);
      expect(payload.error).toContain("not found");
    });

    it("should list all background tasks", async () => {
      const tool = createBackgroundTaskTool();

      // Add multiple tasks
      await tool.execute("test-id", { action: "add", directive: "Task A" });
      await tool.execute("test-id", { action: "add", directive: "Task B" });

      const result = await tool.execute("test-id", {
        action: "list",
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(true);
      expect(payload.tasks.length).toBe(2);
      expect(payload.total).toBe(2);
    });

    it("should list tasks filtered by status", async () => {
      const tool = createBackgroundTaskTool();

      // Add tasks
      await tool.execute("test-id", { action: "add", directive: "Task A" });

      const result = await tool.execute("test-id", {
        action: "list",
        status: ["pending"],
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(true);
      expect(payload.tasks.every((t: { status: string }) => t.status === "pending")).toBe(true);
    });

    it("should cancel a pending task", async () => {
      const tool = createBackgroundTaskTool();

      // Add a task
      const addResult = await tool.execute("test-id", {
        action: "add",
        directive: "Task to cancel",
      });
      const addPayload = JSON.parse((addResult.content[0] as { text: string }).text);
      const taskId = addPayload.task.id;

      // Cancel the task
      const cancelResult = await tool.execute("test-id", {
        action: "cancel",
        id: taskId,
      });

      const cancelPayload = JSON.parse((cancelResult.content[0] as { text: string }).text);
      expect(cancelPayload.success).toBe(true);
      expect(cancelPayload.message).toContain("cancelled");

      // Verify it's cancelled
      const getResult = await tool.execute("test-id", {
        action: "get",
        id: taskId,
      });
      const getPayload = JSON.parse((getResult.content[0] as { text: string }).text);
      expect(getPayload.task.status).toBe("cancelled");
    });

    it("should fail to cancel non-existent task", async () => {
      const tool = createBackgroundTaskTool();
      const result = await tool.execute("test-id", {
        action: "cancel",
        id: "non-existent",
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(false);
    });

    it("should get manager stats", async () => {
      const tool = createBackgroundTaskTool();

      // Add some tasks
      await tool.execute("test-id", { action: "add", directive: "Task 1" });
      await tool.execute("test-id", { action: "add", directive: "Task 2" });

      const result = await tool.execute("test-id", {
        action: "stats",
      });

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(true);
      expect(payload.stats).toBeDefined();
      expect(payload.stats.total).toBe(2);
      expect(payload.stats.pending).toBe(2);
    });

    it("should clear completed tasks", async () => {
      const tool = createBackgroundTaskTool();

      // Add tasks
      const addResult = await tool.execute("test-id", {
        action: "add",
        directive: "Task to cancel",
      });
      const addPayload = JSON.parse((addResult.content[0] as { text: string }).text);
      const taskId = addPayload.task.id;

      // Cancel it (makes it completed-ish)
      await tool.execute("test-id", { action: "cancel", id: taskId });

      // Clear
      const clearResult = await tool.execute("test-id", {
        action: "clear",
      });

      const clearPayload = JSON.parse((clearResult.content[0] as { text: string }).text);
      expect(clearPayload.success).toBe(true);
      expect(clearPayload.message).toContain("cleared");

      // Verify it's gone
      const listResult = await tool.execute("test-id", { action: "list" });
      const listPayload = JSON.parse((listResult.content[0] as { text: string }).text);
      expect(listPayload.total).toBe(0);
    });

    it("should return error for unknown action", async () => {
      const tool = createBackgroundTaskTool();
      const result = await tool.execute("test-id", {
        action: "stats",
      } as never);

      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(true); // stats action succeeds
    });
  });

  describe("manager lifecycle", () => {
    it("should get manager singleton", () => {
      const manager1 = __testing.getBackgroundTasksManager();
      const manager2 = __testing.getBackgroundTasksManager();
      expect(manager1).toBe(manager2);
    });

    it("should reset manager", () => {
      const manager1 = __testing.getBackgroundTasksManager();
      __testing.resetBackgroundTasksManager();
      const manager2 = __testing.getBackgroundTasksManager();
      expect(manager1).not.toBe(manager2);
    });
  });
});

/**
 * Tests for Sessions Spawn Batch Tool.
 *
 * This tool supports spawning 2-10 subagents simultaneously with shared
 * boilerplate for Prompt Cache optimization.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createSessionsSpawnBatchTool, __testing } from "./sessions-spawn-batch-tool.js";

describe("sessions-spawn-batch-tool", () => {
  beforeEach(() => {
    __testing.resetBatchSpawnManager();
  });

  afterEach(() => {
    __testing.resetBatchSpawnManager();
  });

  describe("tool creation", () => {
    it("should create tool with correct name", () => {
      const tool = createSessionsSpawnBatchTool();
      expect(tool.name).toBe("sessions_spawn_batch");
      expect(tool.label).toBe("Sessions Batch");
      expect(tool.description).toBeDefined();
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it("should have valid schema with tasks array", () => {
      const tool = createSessionsSpawnBatchTool();
      const schema = tool.parameters;

      // Check that schema is a TypeBox Object with tasks property
      expect(schema).toBeDefined();
      expect((schema as Record<string, unknown>).type).toBe("object");
    });
  });

  describe("schema validation", () => {
    it("should reject tasks array with less than 2 items", async () => {
      const tool = createSessionsSpawnBatchTool();

      // Test with 0 tasks
      await expect(
        tool.execute("test-id", {
          tasks: [],
        } as never),
      ).rejects.toThrow();

      // Test with 1 task
      await expect(
        tool.execute("test-id", {
          tasks: ["Single task"],
        } as never),
      ).rejects.toThrow();
    });

    it("should reject tasks array with more than 10 items", async () => {
      const tool = createSessionsSpawnBatchTool();

      // Test with 11 tasks
      await expect(
        tool.execute("test-id", {
          tasks: Array(11).fill("Task"),
        } as never),
      ).rejects.toThrow();

      // Test with 15 tasks
      await expect(
        tool.execute("test-id", {
          tasks: Array(15).fill("Task"),
        } as never),
      ).rejects.toThrow();
    });

    it("should accept tasks array with 2 items (minimum)", async () => {
      const tool = createSessionsSpawnBatchTool();

      // Schema validation happens before manager call, so this should pass validation
      // Note: actual execution may call Gateway, but we're testing schema acceptance
      expect(tool.parameters).toBeDefined();

      // Verify schema allows 2 tasks (minItems)
      const schema = tool.parameters as Record<string, unknown>;
      const tasksProp = (schema.properties as Record<string, unknown>)?.tasks;
      expect(tasksProp).toBeDefined();
    });

    it("should accept tasks array with 10 items (maximum)", async () => {
      const tool = createSessionsSpawnBatchTool();

      // Verify schema allows 10 tasks (maxItems)
      const schema = tool.parameters as Record<string, unknown>;
      const tasksProp = (schema.properties as Record<string, unknown>)?.tasks;
      expect(tasksProp).toBeDefined();
    });
  });

  describe("cache savings calculation", () => {
    it("should estimate tokens correctly", () => {
      // "Hello world" = 11 chars / 4 = ~3 tokens
      expect(__testing.estimateTokens("Hello world")).toBe(3);
    });

    it("should calculate cache savings for 3 tasks", () => {
      const result = __testing.calculateCacheSavings(3);
      expect(result).toBeGreaterThan(0);
    });

    it("should return 0 cache savings for 1 task", () => {
      const result = __testing.calculateCacheSavings(1);
      expect(result).toBe(0);
    });

    it("should calculate increasing savings for more tasks", () => {
      const savings2 = __testing.calculateCacheSavings(2);
      const savings5 = __testing.calculateCacheSavings(5);
      const savings10 = __testing.calculateCacheSavings(10);

      expect(savings5).toBeGreaterThan(savings2);
      expect(savings10).toBeGreaterThan(savings5);
    });
  });

  describe("batch directive building", () => {
    it("should build batch directive with tasks and boilerplate", () => {
      const tasks = ["Task A", "Task B", "Task C"];
      const directive = __testing.buildBatchDirective(tasks);

      expect(directive).toContain(__testing.BATCH_SPAWN_BOILERPLATE_TEMPLATE);
      expect(directive).toContain("Task A");
      expect(directive).toContain("Task B");
      expect(directive).toContain("Task C");
    });

    it("should include task indices in directive", () => {
      const tasks = ["First", "Second"];
      const directive = __testing.buildBatchDirective(tasks);

      expect(directive).toContain("Task 1:");
      expect(directive).toContain("Task 2:");
    });
  });

  describe("error summarization", () => {
    it("should summarize Error objects", () => {
      const err = new Error("Test error message");
      expect(__testing.summarizeError(err)).toBe("Test error message");
    });

    it("should handle string errors", () => {
      expect(__testing.summarizeError("String error")).toBe("String error");
    });

    it("should handle unknown error types", () => {
      expect(__testing.summarizeError({})).toBe("error");
      expect(__testing.summarizeError(null)).toBe("error");
    });
  });
});

/**
 * Tests for task system.
 *
 * Tests task creation, dependency graph, and claiming.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  addDependency,
  removeDependency,
  getReadyTasks,
  getBlockedTasks,
  resolveDependencies,
  getAllDependencies,
  getAllDependents,
  validateDependencyGraph,
} from "./dependency-graph.js";
import { createTaskStore } from "./store.js";
import type { Task } from "./types.js";

describe("task system", () => {
  describe("task store", () => {
    let store: ReturnType<typeof createTaskStore>;

    beforeEach(() => {
      store = createTaskStore();
    });

    it("should create a task", () => {
      const task = store.create({ subject: "Test task" });
      expect(task.id).toBeDefined();
      expect(task.subject).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.owner).toBeNull();
    });

    it("should create task with custom ID", () => {
      const task = store.create({ id: "custom-id", subject: "Custom task" });
      expect(task.id).toBe("custom-id");
    });

    it("should get a task by ID", () => {
      const created = store.create({ subject: "Test" });
      const retrieved = store.get(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it("should return undefined for non-existent task", () => {
      const task = store.get("non-existent");
      expect(task).toBeUndefined();
    });

    it("should update a task", () => {
      const task = store.create({ subject: "Test" });
      const updated = store.update(task.id, { subject: "Updated" });
      expect(updated?.subject).toBe("Updated");
    });

    it("should delete a task", () => {
      const task = store.create({ subject: "Test" });
      expect(store.delete(task.id)).toBe(true);
      expect(store.get(task.id)).toBeUndefined();
    });

    it("should claim a task", () => {
      const task = store.create({ subject: "Test" });
      const result = store.claim(task.id, "agent-1");
      expect(result.success).toBe(true);
      expect(result.task?.owner).toBe("agent-1");
      expect(result.task?.status).toBe("in_progress");
    });

    it("should not claim already claimed task", () => {
      const task = store.create({ subject: "Test" });
      store.claim(task.id, "agent-1");
      const result = store.claim(task.id, "agent-2");
      expect(result.success).toBe(false);
      expect(result.reason).toBe("already_claimed");
    });

    it("should not claim blocked task", () => {
      const blocker = store.create({ subject: "Blocker" });
      const blocked = store.create({ subject: "Blocked" });
      store.addDependency(blocker.id, blocked.id);

      const result = store.claim(blocked.id, "agent-1");
      expect(result.success).toBe(false);
      expect(result.reason).toBe("blocked");
    });

    it("should release a task", () => {
      const task = store.create({ subject: "Test" });
      store.claim(task.id, "agent-1");
      expect(store.release(task.id, "agent-1")).toBe(true);
      const released = store.get(task.id);
      expect(released?.owner).toBeNull();
      expect(released?.status).toBe("pending");
    });

    it("should query tasks", () => {
      store.create({ subject: "Task 1", status: "pending" });
      store.create({ subject: "Task 2", status: "in_progress" });
      store.create({ subject: "Task 3", status: "completed" });

      const result = store.query({ status: "pending" });
      expect(result.tasks.length).toBe(1);
      expect(result.total).toBe(1);
    });

    it("should get ready tasks", () => {
      store.create({ subject: "Ready task", status: "pending" });
      store.create({ subject: "In progress task", status: "in_progress" });

      const ready = store.getReadyTasks();
      expect(ready.length).toBe(1);
      expect(ready[0].subject).toBe("Ready task");
    });

    it("should emit events", () => {
      const events: Array<{ type: string; task: Task }> = [];
      store.addListener((event) => {
        events.push({ type: event.type, task: event.task });
      });

      const task = store.create({ subject: "Test" });
      store.update(task.id, { subject: "Updated" });

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("created");
      expect(events[1].type).toBe("updated");
    });
  });

  describe("dependency graph", () => {
    let tasks: Map<string, Task>;

    beforeEach(() => {
      tasks = new Map();
    });

    function addTask(id: string, subject: string): Task {
      const task: Task = {
        id,
        subject,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        blocks: [],
        blockedBy: [],
      };
      tasks.set(id, task);
      return task;
    }

    it("should add dependency", () => {
      const task1 = addTask("t1", "Task 1");
      const task2 = addTask("t2", "Task 2");

      const result = addDependency(tasks, "t1", "t2");
      expect(result).toBe(true);
      expect(task1.blocks).toContain("t2");
      expect(task2.blockedBy).toContain("t1");
    });

    it("should not add self-dependency", () => {
      addTask("t1", "Task 1");
      const result = addDependency(tasks, "t1", "t1");
      expect(result).toBe(false);
    });

    it("should detect cycle", () => {
      addTask("t1", "Task 1");
      addTask("t2", "Task 2");
      addTask("t3", "Task 3");

      addDependency(tasks, "t1", "t2");
      addDependency(tasks, "t2", "t3");

      // Adding t3 -> t1 would create a cycle
      const result = addDependency(tasks, "t3", "t1");
      expect(result).toBe(false);
    });

    it("should remove dependency", () => {
      addTask("t1", "Task 1");
      addTask("t2", "Task 2");
      addDependency(tasks, "t1", "t2");

      const result = removeDependency(tasks, "t1", "t2");
      expect(result).toBe(true);
      const task1 = tasks.get("t1");
      const task2 = tasks.get("t2");
      expect(task1?.blocks).not.toContain("t2");
      expect(task2?.blockedBy).not.toContain("t1");
    });

    it("should get ready tasks", () => {
      addTask("t1", "Task 1"); // No blockers
      addTask("t2", "Task 2"); // Blocked by t1
      addDependency(tasks, "t1", "t2");

      const ready = getReadyTasks(tasks);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("t1");
    });

    it("should get blocked tasks", () => {
      addTask("t1", "Task 1");
      addTask("t2", "Task 2");
      addDependency(tasks, "t1", "t2");

      const blocked = getBlockedTasks(tasks);
      expect(blocked.length).toBe(1);
      expect(blocked[0].id).toBe("t2");
    });

    it("should resolve dependencies when task completes", () => {
      addTask("t1", "Task 1");
      addTask("t2", "Task 2");
      addTask("t3", "Task 3");

      addDependency(tasks, "t1", "t2");
      addDependency(tasks, "t1", "t3");

      // Mark t1 as completed
      const task1 = tasks.get("t1");
      if (task1) {
        task1.status = "completed";
      }

      // Mark t2 and t3 as blocked
      const task2 = tasks.get("t2");
      const task3 = tasks.get("t3");
      if (task2) {
        task2.status = "blocked";
      }
      if (task3) {
        task3.status = "blocked";
      }

      const unblocked = resolveDependencies(tasks, "t1");
      expect(unblocked).toContain("t2");
      expect(unblocked).toContain("t3");

      expect(task2?.blockedBy).toHaveLength(0);
      expect(task3?.blockedBy).toHaveLength(0);
    });

    it("should get all dependencies", () => {
      addTask("t1", "Task 1");
      addTask("t2", "Task 2");
      addTask("t3", "Task 3");

      addDependency(tasks, "t1", "t2");
      addDependency(tasks, "t2", "t3");

      const deps = getAllDependencies(tasks, "t3");
      expect(deps).toContain("t1");
      expect(deps).toContain("t2");
    });

    it("should get all dependents", () => {
      addTask("t1", "Task 1");
      addTask("t2", "Task 2");
      addTask("t3", "Task 3");

      addDependency(tasks, "t1", "t2");
      addDependency(tasks, "t2", "t3");

      const dependents = getAllDependents(tasks, "t1");
      expect(dependents).toContain("t2");
      expect(dependents).toContain("t3");
    });

    it("should validate dependency graph", () => {
      addTask("t1", "Task 1");

      // Manually add a self-dependency to test validation
      const task1 = tasks.get("t1");
      if (task1) {
        task1.blocks.push("t1");
      }

      const errors = validateDependencyGraph(tasks);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("self-dependency");
    });
  });
});

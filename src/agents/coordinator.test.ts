/**
 * Tests for Coordinator Pattern.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createTaskCoordinator,
  shouldTriggerIdleCycle,
  getNextReadyTask,
  TaskCoordinator,
  type CoordinatorTaskStore,
  type CoordinatorTask,
} from "./coordinator.js";

// Mock task store for testing
class MockTaskStore implements CoordinatorTaskStore {
  private tasks: Map<string, CoordinatorTask> = new Map();

  create(subject: string, options?: Partial<CoordinatorTask>): CoordinatorTask {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const task: CoordinatorTask = {
      id,
      subject,
      status: options?.status ?? "pending",
      owner: options?.owner,
      priority: options?.priority ?? "medium",
      blockedBy: options?.blockedBy ?? [],
      blocks: options?.blocks ?? [],
    };
    this.tasks.set(id, task);
    return task;
  }

  get(id: string): CoordinatorTask | undefined {
    return this.tasks.get(id);
  }

  getReadyTasks(): CoordinatorTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === "pending" && t.blockedBy.length === 0 && !t.owner,
    );
  }

  getBlockedTasks(): CoordinatorTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.blockedBy.length > 0);
  }

  claim(
    id: string,
    owner: string,
    _sessionKey?: string,
  ): { success: boolean; task?: CoordinatorTask; error?: string } {
    const task = this.tasks.get(id);
    if (!task) {
      return { success: false, error: "Task not found" };
    }
    if (task.owner) {
      return { success: false, error: "Task already claimed" };
    }
    if (task.status !== "pending") {
      return { success: false, error: "Task not in pending status" };
    }
    const updated = { ...task, owner, status: "in_progress" as const };
    this.tasks.set(id, updated);
    return { success: true, task: updated };
  }

  release(id: string, owner: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) {
      return false;
    }
    const updated = { ...task, owner: undefined, status: "pending" as const };
    this.tasks.set(id, updated);
    return true;
  }

  update(id: string, updates: Partial<CoordinatorTask>): CoordinatorTask | undefined {
    const task = this.tasks.get(id);
    if (!task) {
      return undefined;
    }
    const updated = { ...task, ...updates };
    this.tasks.set(id, updated);
    return updated;
  }

  addDependency(fromId: string, toId: string): boolean {
    const from = this.tasks.get(fromId);
    const to = this.tasks.get(toId);
    if (!from || !to) {
      return false;
    }
    from.blocks.push(toId);
    to.blockedBy.push(fromId);
    return true;
  }
}

describe("coordinator", () => {
  let taskStore: MockTaskStore;
  let coordinator: TaskCoordinator;

  beforeEach(() => {
    taskStore = new MockTaskStore();
    coordinator = createTaskCoordinator(taskStore, {
      agentId: "agent-1",
      sessionKey: "session-1",
      maxTasksPerCycle: 3,
      idleCheckInterval: 1000,
      autoClaimEnabled: true,
    });
  });

  afterEach(() => {
    coordinator.stop();
  });

  describe("start/stop", () => {
    it("should start and stop coordinator", () => {
      coordinator.start();
      const state = coordinator.getState();
      expect(state.isActive).toBe(true);

      coordinator.stop();
      const stoppedState = coordinator.getState();
      expect(stoppedState.isActive).toBe(false);
    });

    it("should not start twice", () => {
      coordinator.start();
      coordinator.start(); // Second start should be ignored

      const state = coordinator.getState();
      expect(state.isActive).toBe(true);
    });

    it("should release claimed tasks on stop", async () => {
      // Create a pending task
      taskStore.create("Test task");

      coordinator.start();
      // Claim task through idle cycle
      const result = await coordinator.idleCycle();

      // Verify task was claimed
      expect(result.claimed.length).toBe(1);
      const claimedTaskId = result.claimed[0].id;

      // Check the task in the store has owner
      const storeTask = taskStore.get(claimedTaskId);
      expect(storeTask?.owner).toBe("agent-1");

      coordinator.stop();

      // Task should be released in the store
      const releasedTask = taskStore.get(claimedTaskId);
      expect(releasedTask?.owner).toBeUndefined();
    });
  });

  describe("idleCycle", () => {
    it("should claim ready tasks on idle cycle", async () => {
      // Create pending tasks
      taskStore.create("Task A");
      taskStore.create("Task B");
      taskStore.create("Task C");

      coordinator.start();
      const result = await coordinator.idleCycle();

      expect(result.actionTaken).toBe(true);
      expect(result.claimed.length).toBe(3);
      expect(result.claimed.every((t) => t.owner === "agent-1")).toBe(true);
    });

    it("should respect maxTasksPerCycle", async () => {
      // Create 5 pending tasks
      for (let i = 0; i < 5; i++) {
        taskStore.create(`Task ${i}`);
      }

      coordinator.start();
      const result = await coordinator.idleCycle();

      // maxTasksPerCycle is 3
      expect(result.claimed.length).toBe(3);
    });

    it("should return empty when no ready tasks", async () => {
      // Create tasks with proper blocking relationship
      const task1 = taskStore.create("Task 1", { status: "in_progress", owner: "other" });
      const task2 = taskStore.create("Task 2");
      // Make task2 depend on task1 (task2 is blocked until task1 completes)
      task2.blockedBy.push(task1.id);

      coordinator.start();
      const result = await coordinator.idleCycle();

      expect(result.actionTaken).toBe(false);
      expect(result.claimed.length).toBe(0);
    });

    it("should return empty when coordinator not active", async () => {
      const result = await coordinator.idleCycle();
      expect(result.actionTaken).toBe(false);
    });

    it("should not claim without agentId", async () => {
      const noAgentCoordinator = createTaskCoordinator(taskStore, {
        autoClaimEnabled: true,
      });

      taskStore.create("Task");

      noAgentCoordinator.start();
      const result = await noAgentCoordinator.idleCycle();

      expect(result.claimed.length).toBe(0);

      noAgentCoordinator.stop();
    });

    it("should skip already claimed tasks", async () => {
      const task1 = taskStore.create("Task 1");
      const task2 = taskStore.create("Task 2");

      // Claim task1 manually
      taskStore.claim(task1.id, "other-agent");

      coordinator.start();
      const result = await coordinator.idleCycle();

      // Should only claim task2
      expect(result.claimed.length).toBe(1);
      expect(result.claimed[0].id).toBe(task2.id);
    });
  });

  describe("completeTask", () => {
    it("should mark task as completed", () => {
      const task = taskStore.create("Test");
      taskStore.claim(task.id, "agent-1");

      coordinator.start();
      coordinator.completeTask(task.id);

      const completedTask = taskStore.get(task.id);
      expect(completedTask?.status).toBe("completed");

      const state = coordinator.getState();
      expect(state.completedTasks.some((t) => t.id === task.id)).toBe(true);
      expect(state.claimedTasks.some((t) => t.id === task.id)).toBe(false);
    });

    it("should return false for non-existent task", () => {
      const result = coordinator.completeTask("non-existent");
      expect(result).toBe(false);
    });

    it("should track completed tasks", () => {
      const task1 = taskStore.create("Task 1");
      const task2 = taskStore.create("Task 2");

      coordinator.start();
      coordinator.completeTask(task1.id);
      coordinator.completeTask(task2.id);

      const state = coordinator.getState();
      expect(state.completedTasks.length).toBe(2);
    });
  });

  describe("getState", () => {
    it("should return current state", () => {
      coordinator.start();
      const state = coordinator.getState();

      expect(state.isActive).toBe(true);
      expect(state.claimedTasks).toEqual([]);
      expect(state.completedTasks).toEqual([]);
      expect(state.lastIdleCheck).toBeGreaterThan(0);
    });

    it("should return copy of claimed tasks", async () => {
      taskStore.create("Task");

      coordinator.start();
      await coordinator.idleCycle();

      const state1 = coordinator.getState();
      const state2 = coordinator.getState();

      // Modifications to one state shouldn't affect the other
      state1.claimedTasks.pop();
      expect(state2.claimedTasks.length).toBe(1);
    });
  });

  describe("isIdle", () => {
    it("should be idle when no claimed tasks", () => {
      expect(coordinator.isIdle()).toBe(true);
    });

    it("should not be idle when tasks claimed", async () => {
      taskStore.create("Task");

      coordinator.start();
      await coordinator.idleCycle();

      expect(coordinator.isIdle()).toBe(false);
    });

    it("should be idle after completing all tasks", async () => {
      const task = taskStore.create("Task");

      coordinator.start();
      await coordinator.idleCycle();
      coordinator.completeTask(task.id);

      expect(coordinator.isIdle()).toBe(true);
    });
  });
});

describe("shouldTriggerIdleCycle", () => {
  it("should return false when autoClaim disabled", () => {
    const state = {
      claimedTasks: [],
      completedTasks: [],
      lastIdleCheck: Date.now() - 60000,
      isActive: true,
    };
    const config = { autoClaimEnabled: false, idleCheckInterval: 30000 };

    expect(shouldTriggerIdleCycle(state, config)).toBe(false);
  });

  it("should return false when tasks claimed", () => {
    const mockTask: CoordinatorTask = {
      id: "task-1",
      subject: "Test",
      status: "in_progress",
      owner: "agent-1",
      blockedBy: [],
      blocks: [],
    };

    const state = {
      claimedTasks: [mockTask],
      completedTasks: [],
      lastIdleCheck: Date.now() - 60000,
      isActive: true,
    };
    const config = { autoClaimEnabled: true, idleCheckInterval: 30000 };

    expect(shouldTriggerIdleCycle(state, config)).toBe(false);
  });

  it("should return true when idle and interval elapsed", () => {
    const state = {
      claimedTasks: [],
      completedTasks: [],
      lastIdleCheck: Date.now() - 60000,
      isActive: true,
    };
    const config = { autoClaimEnabled: true, idleCheckInterval: 30000 };

    expect(shouldTriggerIdleCycle(state, config)).toBe(true);
  });

  it("should return false when interval not elapsed", () => {
    const state = {
      claimedTasks: [],
      completedTasks: [],
      lastIdleCheck: Date.now() - 10000,
      isActive: true,
    };
    const config = { autoClaimEnabled: true, idleCheckInterval: 30000 };

    expect(shouldTriggerIdleCycle(state, config)).toBe(false);
  });
});

describe("getNextReadyTask", () => {
  let taskStore: MockTaskStore;

  beforeEach(() => {
    taskStore = new MockTaskStore();
  });

  it("should return null when no ready tasks", () => {
    const result = getNextReadyTask(taskStore);
    expect(result).toBeNull();
  });

  it("should return highest priority task", () => {
    taskStore.create("Low", { priority: "low" });
    taskStore.create("Medium", { priority: "medium" });
    taskStore.create("Critical", { priority: "critical" });

    const result = getNextReadyTask(taskStore);
    expect(result?.subject).toBe("Critical");
  });

  it("should skip blocked tasks", () => {
    const blocked = taskStore.create("Blocked");
    const blocker = taskStore.create("Blocker");
    taskStore.addDependency(blocker.id, blocked.id);

    // Only blocker is ready
    const result = getNextReadyTask(taskStore);
    expect(result?.subject).toBe("Blocker");
  });

  it("should skip already claimed tasks", () => {
    const claimed = taskStore.create("Claimed");
    taskStore.create("Available");

    taskStore.claim(claimed.id, "other-agent");

    const result = getNextReadyTask(taskStore);
    expect(result?.subject).toBe("Available");
  });
});

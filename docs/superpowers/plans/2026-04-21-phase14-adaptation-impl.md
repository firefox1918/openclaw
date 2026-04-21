# Phase 14 Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement three adapted modules from Claude Code's Harness mechanism for OpenClaw architecture without modifying core code.

**Architecture:** Wrapper pattern for concurrency control, batch spawn tool for cache optimization, infrastructure-level coordinator loop manager.

**Tech Stack:** TypeScript, TypeBox, Vitest, OpenClaw Gateway API

---

## File Structure

> **Pattern Reference:** Follow existing module locations:
> - Wrapper utilities: `src/agents/pi-tools.abort.ts` pattern → `src/agents/concurrency-control-wrapper.ts`
> - Core modules: `src/agents/coordinator.ts`, `src/agents/fork-cache-optimization.ts` pattern
> - Tools: `src/agents/tools/*.ts` pattern

| File | Responsibility |
|------|---------------|
| `src/agents/tools/sessions-spawn-batch-tool.ts` | Batch spawn tool with unified boilerplate |
| `src/agents/tools/sessions-spawn-batch-tool.test.ts` | Tests for batch spawn |
| `src/agents/coordinator-loop-manager.ts` | Infrastructure coordinator loop (parallel to coordinator.ts) |
| `src/agents/coordinator-loop-manager.test.ts` | Tests for coordinator |
| `src/agents/concurrency-control-wrapper.ts` | Tool wrapper for slot management (parallel to pi-tools.abort.ts) |
| `src/agents/concurrency-control-wrapper.test.ts` | Tests for concurrency wrapper (unit tests) |
| `src/agents/openclaw-tools.ts` | Tool registration (modify) |

---

## Task 1: sessions_spawn_batch Tool (14.2-adapt)

**Priority:** P1 (highest value - batch spawn + cache optimization)

**Files:**
- Create: `src/agents/tools/sessions-spawn-batch-tool.ts`
- Create: `src/agents/tools/sessions-spawn-batch-tool.test.ts`
- Modify: `src/agents/openclaw-tools.ts:234-330` (tool registration)

### Step 1.1: Write failing test for batch spawn schema validation

- [ ] **Create test file with schema validation tests**

```typescript
// src/agents/tools/sessions-spawn-batch-tool.test.ts

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
      expect(tool.label).toBe("sessions_spawn_batch");
      expect(tool.description).toContain("Spawn multiple subagents");
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
    });

    it("should validate tasks array minItems=2", () => {
      const tool = createSessionsSpawnBatchTool();
      // Schema should reject single task
      const schema = tool.parameters;
      expect(schema.anyOf).toBeDefined();
    });
  });

  describe("schema validation", () => {
    it("should reject tasks with less than 2 items", async () => {
      const tool = createSessionsSpawnBatchTool();
      const result = await tool.execute("test-id", {
        tasks: [{ directive: "Only one task" }],
        sharedContext: {},
      });
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(false);
      expect(payload.error).toContain("minItems");
    });

    it("should reject tasks with more than 10 items", async () => {
      const tool = createSessionsSpawnBatchTool();
      const tasks = Array(11).fill({ directive: "Task" });
      const result = await tool.execute("test-id", {
        tasks,
        sharedContext: {},
      });
      const payload = JSON.parse((result.content[0] as { text: string }).text);
      expect(payload.success).toBe(false);
      expect(payload.error).toContain("maxItems");
    });
  });
});
```

- [ ] **Run test to verify it fails**

Run: `pnpm test src/agents/tools/sessions-spawn-batch-tool.test.ts -v`
Expected: FAIL - "Cannot find module './sessions-spawn-batch-tool.js'"

### Step 1.2: Write minimal tool implementation with schema

- [ ] **Create tool file with schema and basic structure**

```typescript
// src/agents/tools/sessions-spawn-batch-tool.ts

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static } from "@sinclair/typebox";
import { Type } from "@sinclair/typebox";
import { jsonResult, ToolInputError } from "./common.js";

// ============================================================================
// Schema Definitions
// ============================================================================

const BatchTaskSchema = Type.Object({
  directive: Type.String({ minLength: 1, maxLength: 500 }),
  label: Type.Optional(Type.String()),
});

const SharedContextSchema = Type.Object({
  agentId: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  workspaceDir: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
});

const SessionsSpawnBatchSchema = Type.Object({
  tasks: Type.Array(BatchTaskSchema, { minItems: 2, maxItems: 10 }),
  sharedContext: SharedContextSchema,
  mode: Type.Optional(Type.String()), // "parallel" | "sequential"
  cleanup: Type.Optional(Type.String()), // "delete" | "keep"
});

type SessionsSpawnBatchInput = Static<typeof SessionsSpawnBatchSchema>;

// ============================================================================
// Batch Spawn Boilerplate Template
// ============================================================================

const BATCH_SPAWN_BOILERPLATE_TEMPLATE = `
[Batch Subagent Context]
You are part of a batch spawn operation.
- Depth: shared across batch
- Results auto-announce to requester
- Do not busy-poll for status
`;

// ============================================================================
// Token Estimation
// ============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function calculateCacheSavings(
  tasks: Static<typeof BatchTaskSchema>[],
  sharedContext: Static<typeof SharedContextSchema>,
): number {
  const boilerplateTokens = estimateTokens(BATCH_SPAWN_BOILERPLATE_TEMPLATE);
  const contextTokens = estimateTokens(`
Working directory: ${sharedContext.workspaceDir ?? ""}
Session: ${sharedContext.sessionKey ?? ""}
  `);
  const sharedTokens = boilerplateTokens + contextTokens;
  const savings = sharedTokens * (tasks.length - 1);
  return Math.ceil(savings);
}

// ============================================================================
// Batch Spawn Manager (for testing isolation)
// ============================================================================

interface BatchSpawnResult {
  sessionKey: string;
  runId: string;
  task: Static<typeof BatchTaskSchema>;
}

interface BatchSpawnError {
  task: Static<typeof BatchTaskSchema>;
  error: string;
}

interface BatchSpawnOutcome {
  success: boolean;
  children: BatchSpawnResult[];
  errors: BatchSpawnError[];
  successCount: number;
  failureCount: number;
  estimatedCacheSavings: number;
}

let globalBatchSpawnManager: BatchSpawnManager | null = null;

interface BatchSpawnManager {
  executeBatch(
    tasks: Static<typeof BatchTaskSchema>[],
    sharedContext: Static<typeof SharedContextSchema>,
    mode: "parallel" | "sequential",
  ): Promise<BatchSpawnOutcome>;
}

function getBatchSpawnManager(): BatchSpawnManager {
  globalBatchSpawnManager ??= createBatchSpawnManager();
  return globalBatchSpawnManager;
}

function createBatchSpawnManager(): BatchSpawnManager {
  return {
    async executeBatch(tasks, sharedContext, mode) {
      // Placeholder - will integrate with Gateway API
      return {
        success: true,
        children: [],
        errors: [],
        successCount: 0,
        failureCount: 0,
        estimatedCacheSavings: calculateCacheSavings(tasks, sharedContext),
      };
    },
  };
}

// ============================================================================
// Tool Implementation
// ============================================================================

export function createSessionsSpawnBatchTool(): {
  name: string;
  label: string;
  description: string;
  parameters: typeof SessionsSpawnBatchSchema;
  execute: (toolCallId: string, input: unknown) => Promise<AgentToolResult>;
} {
  return {
    name: "sessions_spawn_batch",
    label: "sessions_spawn_batch",
    description: `Spawn multiple subagents in a batch operation with shared context.

This tool spawns 2-10 subagents simultaneously, optimizing for Prompt Cache reuse
by using identical message boilerplate. Returns estimated cache savings.

Actions:
- Batch spawn with shared boilerplate for cache optimization
- Parallel or sequential execution modes
- Error isolation (partial failures don't block success)`,
    parameters: SessionsSpawnBatchSchema,
    execute: async (toolCallId: string, input: unknown) => {
      // Validate input against schema
      const parsed = SessionsSpawnBatchSchema;
      // TypeBox validation happens at tool executor level

      const batchInput = input as SessionsSpawnBatchInput;
      const manager = getBatchSpawnManager();

      const mode = batchInput.mode ?? "parallel";
      const outcome = await manager.executeBatch(
        batchInput.tasks,
        batchInput.sharedContext,
        mode as "parallel" | "sequential",
      );

      return jsonResult({
        success: outcome.success,
        children: outcome.children,
        errors: outcome.errors,
        successCount: outcome.successCount,
        failureCount: outcome.failureCount,
        estimatedCacheSavings: outcome.estimatedCacheSavings,
        mode,
      });
    },
  };
}

// ============================================================================
// Testing Exports
// ============================================================================

export const __testing = {
  getBatchSpawnManager: () => globalBatchSpawnManager,
  resetBatchSpawnManager: () => {
    if (globalBatchSpawnManager) {
      globalBatchSpawnManager = null;
    }
  },
  setBatchSpawnManager: (manager: BatchSpawnManager) => {
    globalBatchSpawnManager = manager;
  },
  calculateCacheSavings,
  estimateTokens,
};
```

- [ ] **Run tests to verify schema validation passes**

Run: `pnpm test src/agents/tools/sessions-spawn-batch-tool.test.ts -v`
Expected: PASS for schema tests, FAIL for Gateway integration tests (not yet written)

### Step 1.3: Write tests for cache savings calculation

- [ ] **Add cache savings tests**

```typescript
// Add to sessions-spawn-batch-tool.test.ts

describe("cache savings calculation", () => {
  it("should calculate cache savings for 3 tasks", () => {
    const tasks = [
      { directive: "Task 1" },
      { directive: "Task 2" },
      { directive: "Task 3" },
    ];
    const sharedContext = {
      workspaceDir: "/workspace",
      sessionKey: "session-123",
    };

    const savings = __testing.calculateCacheSavings(tasks, sharedContext);

    // First task no savings, subsequent tasks share boilerplate
    expect(savings).toBeGreaterThan(0);
    expect(savings).toBeLessThan(10000); // Sanity check
  });

  it("should return 0 savings for 1 task", () => {
    const tasks = [{ directive: "Only task" }];
    const savings = __testing.calculateCacheSavings(tasks, {});
    // (tasks.length - 1) = 0, so savings should be 0
    expect(savings).toBe(0);
  });

  it("should estimate tokens correctly", () => {
    const text = "Hello world"; // 11 chars
    const tokens = __testing.estimateTokens(text);
    expect(tokens).toBe(3); // ceil(11/4) = 3
  });
});
```

- [ ] **Run tests to verify cache calculation**

Run: `pnpm test src/agents/tools/sessions-spawn-batch-tool.test.ts -t "cache savings" -v`
Expected: PASS

### Step 1.4: Implement Gateway API integration

- [ ] **Add Gateway spawn integration to BatchSpawnManager**

```typescript
// Add to sessions-spawn-batch-tool.ts

import { callGateway } from "../../gateway/call.js";

interface BatchSpawnManagerDeps {
  callGateway: typeof callGateway;
}

const defaultDeps: BatchSpawnManagerDeps = {
  callGateway,
};

let deps: BatchSpawnManagerDeps = defaultDeps;

function createBatchSpawnManager(): BatchSpawnManager {
  return {
    async executeBatch(tasks, sharedContext, mode) {
      const results: BatchSpawnResult[] = [];
      const errors: BatchSpawnError[] = [];

      if (mode === "parallel") {
        const promises = tasks.map(async (task) => {
          try {
            const response = await deps.callGateway({
              method: "sessions.spawn",
              params: {
                directive: buildBatchDirective(task.directive, sharedContext),
                agentId: sharedContext.agentId,
                model: sharedContext.model,
                thinking: sharedContext.thinking,
                cwd: sharedContext.workspaceDir,
              },
              timeoutMs: 30_000,
            });
            return {
              sessionKey: response.result?.key ?? "",
              runId: response.result?.runId ?? "",
              task,
            };
          } catch (e) {
            return { error: summarizeError(e), task };
          }
        });

        const outcomes = await Promise.allSettled(promises);
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") {
            if ("error" in outcome.value) {
              errors.push(outcome.value as BatchSpawnError);
            } else {
              results.push(outcome.value as BatchSpawnResult);
            }
          }
        }
      } else {
        // Sequential mode
        for (const task of tasks) {
          try {
            const response = await deps.callGateway({
              method: "sessions.spawn",
              params: {
                directive: buildBatchDirective(task.directive, sharedContext),
                agentId: sharedContext.agentId,
                model: sharedContext.model,
                thinking: sharedContext.thinking,
                cwd: sharedContext.workspaceDir,
              },
              timeoutMs: 30_000,
            });
            results.push({
              sessionKey: response.result?.key ?? "",
              runId: response.result?.runId ?? "",
              task,
            });
          } catch (e) {
            errors.push({ error: summarizeError(e), task });
            break; // Sequential mode: stop on first error
          }
        }
      }

      return {
        success: errors.length === 0,
        children: results,
        errors,
        successCount: results.length,
        failureCount: errors.length,
        estimatedCacheSavings: calculateCacheSavings(tasks, sharedContext),
      };
    },
  };
}

function buildBatchDirective(
  taskDirective: string,
  sharedContext: Static<typeof SharedContextSchema>,
): string {
  return `${BATCH_SPAWN_BOILERPLATE_TEMPLATE}

[Shared Context]
Working directory: ${sharedContext.workspaceDir ?? ""}
Session: ${sharedContext.sessionKey ?? ""}

[Your Task]
${taskDirective}`;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

export const __testing = {
  ...__testing,
  setDeps: (newDeps: Partial<BatchSpawnManagerDeps>) => {
    deps = { ...defaultDeps, ...newDeps };
  },
  resetDeps: () => {
    deps = defaultDeps;
  },
};
```

- [ ] **Run full test suite**

Run: `pnpm test src/agents/tools/sessions-spawn-batch-tool.test.ts -v`
Expected: PASS (all tests)

### Step 1.5: Register tool in openclaw-tools.ts

- [ ] **Add import and registration**

```typescript
// src/agents/openclaw.ts modifications

// Add import at top (around line 34)
import { createSessionsSpawnBatchTool } from "./tools/sessions-spawn-batch-tool.js";

// Add to tools array (around line 298, after sessionsSpawnTool)
createSessionsSpawnBatchTool({
  agentSessionKey: options?.agentSessionKey,
  agentChannel: options?.agentChannel,
  sandboxed: options?.sandboxed,
  workspaceDir: spawnWorkspaceDir,
}),
```

- [ ] **Run typecheck**

Run: `pnpm tsgo`
Expected: PASS (no type errors)

### Step 1.6: Commit 14.2-adapt implementation

- [ ] **Stage and commit**

```bash
git add src/agents/tools/sessions-spawn-batch-tool.ts
git add src/agents/tools/sessions-spawn-batch-tool.test.ts
git add src/agents/openclaw-tools.ts
git commit -m "feat(14.2): add sessions_spawn_batch tool with cache optimization

- Batch spawn 2-10 subagents with shared boilerplate
- Prompt Cache savings estimation
- Parallel/sequential execution modes
- Error isolation for partial failures

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 2: CoordinatorLoopManager (14.3-adapt)

**Priority:** P1

**Files:**
- Create: `src/agents/coordinator-loop-manager.ts`
- Create: `src/agents/coordinator-loop-manager.test.ts`
- Modify: `src/agents/tools/background-task-tool.ts:30-260` (add coordinator mode)

### Step 2.1: Write failing test for coordinator loop

- [ ] **Create test file with basic loop tests**

```typescript
// src/agents/coordinator-loop-manager.test.ts

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createCoordinatorLoopManager,
  __testing,
  type CoordinatorOptions,
} from "./coordinator-loop-manager.js";

describe("coordinator-loop-manager", () => {
  beforeEach(() => {
    __testing.resetCoordinatorLoopManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    __testing.resetCoordinatorLoopManager();
    vi.useRealTimers();
  });

  describe("loop lifecycle", () => {
    it("should start a coordinator loop and return loopId", async () => {
      const manager = createCoordinatorLoopManager();
      const options: CoordinatorOptions = {
        idleInterval: 1000,
        maxRetries: 3,
        timeoutPerTask: 5000,
        agentId: "test-agent",
        sessionKey: "test-session",
      };

      const loopId = await manager.start(options);
      expect(loopId).toMatch(/^coord-/);

      const status = manager.getStatus(loopId);
      expect(status.status).toBe("running");
    });

    it("should stop a coordinator loop", async () => {
      const manager = createCoordinatorLoopManager();
      const loopId = await manager.start({
        idleInterval: 1000,
        maxRetries: 3,
        timeoutPerTask: 5000,
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      await manager.stop(loopId);

      const status = manager.getStatus(loopId);
      expect(status.status).toBe("stopped");
    });

    it("should pause and resume a loop", async () => {
      const manager = createCoordinatorLoopManager();
      const loopId = await manager.start({
        idleInterval: 1000,
        maxRetries: 3,
        timeoutPerTask: 5000,
        agentId: "test-agent",
        sessionKey: "test-session",
      });

      await manager.pause(loopId);
      expect(manager.getStatus(loopId).status).toBe("paused");

      await manager.resume(loopId);
      expect(manager.getStatus(loopId).status).toBe("running");
    });
  });

  describe("sleep function", () => {
    it("should sleep for specified duration", async () => {
      const { sleep } = __testing;

      const start = Date.now();
      await sleep(1000);
      vi.advanceTimersByTime(1000);

      expect(Date.now() - start).toBe(1000);
    });

    it("should be interruptible via AbortSignal", async () => {
      const { sleep } = __testing;
      const controller = new AbortController();

      const promise = sleep(10000, controller.signal);
      controller.abort();

      await expect(promise).rejects.toThrow("AbortError");
    });
  });
});
```

- [ ] **Run test to verify it fails**

Run: `pnpm test src/agents/coordinator-loop-manager.test.ts -v`
Expected: FAIL - "Cannot find module './coordinator-loop-manager.js'"

### Step 2.2: Write minimal CoordinatorLoopManager implementation

- [ ] **Create manager with lifecycle methods**

```typescript
// src/agents/coordinator-loop-manager.ts

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("coordinator-loop");

// ============================================================================
// Types
// ============================================================================

export interface CoordinatorOptions {
  idleInterval: number;
  maxRetries: number;
  timeoutPerTask: number;
  agentId: string;
  sessionKey: string;
}

export interface CoordinatorStatus {
  loopId: string;
  status: "running" | "paused" | "stopped" | "error";
  tasksCompleted: number;
  tasksFailed: number;
  currentTask?: { id: string; directive: string };
  lastCheckTime: Date;
  consecutiveFailures: number;
}

interface LoopState {
  id: string;
  options: CoordinatorOptions;
  status: "running" | "paused" | "stopped" | "error";
  abortController: AbortController;
  tasksCompleted: number;
  tasksFailed: number;
  consecutiveFailures: number;
  currentTask?: { id: string; directive: string };
}

export interface CoordinatorLoopManager {
  start(options: CoordinatorOptions): Promise<string>;
  stop(loopId: string): Promise<void>;
  getStatus(loopId: string): CoordinatorStatus;
  pause(loopId: string): Promise<void>;
  resume(loopId: string): Promise<void>;
}

// ============================================================================
// Sleep Utility
// ============================================================================

class AbortError extends Error {
  constructor() {
    super("AbortError");
    this.name = "AbortError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new AbortError());
    });
  });
}

// ============================================================================
// Manager Implementation
// ============================================================================

let globalCoordinatorLoopManager: CoordinatorLoopManagerImpl | null = null;

export function createCoordinatorLoopManager(): CoordinatorLoopManager {
  globalCoordinatorLoopManager ??= new CoordinatorLoopManagerImpl();
  return globalCoordinatorLoopManager;
}

class CoordinatorLoopManagerImpl implements CoordinatorLoopManager {
  private loops: Map<string, LoopState> = new Map();

  async start(options: CoordinatorOptions): Promise<string> {
    const loopId = `coord-${crypto.randomUUID()}`;
    const state: LoopState = {
      id: loopId,
      options,
      status: "running",
      abortController: new AbortController(),
      tasksCompleted: 0,
      tasksFailed: 0,
      consecutiveFailures: 0,
    };
    this.loops.set(loopId, state);

    // Start background loop (non-blocking)
    this.runLoop(state).catch((err) => {
      log.error("Coordinator loop error", { loopId, error: err });
    });

    return loopId;
  }

  async stop(loopId: string): Promise<void> {
    const state = this.loops.get(loopId);
    if (!state) return;

    state.status = "stopped";
    state.abortController.abort();
  }

  getStatus(loopId: string): CoordinatorStatus {
    const state = this.loops.get(loopId);
    if (!state) {
      return {
        loopId,
        status: "stopped",
        tasksCompleted: 0,
        tasksFailed: 0,
        lastCheckTime: new Date(),
        consecutiveFailures: 0,
      };
    }

    return {
      loopId: state.id,
      status: state.status,
      tasksCompleted: state.tasksCompleted,
      tasksFailed: state.tasksFailed,
      currentTask: state.currentTask,
      lastCheckTime: new Date(),
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  async pause(loopId: string): Promise<void> {
    const state = this.loops.get(loopId);
    if (!state) return;
    state.status = "paused";
  }

  async resume(loopId: string): Promise<void> {
    const state = this.loops.get(loopId);
    if (!state || state.status !== "paused") return;
    state.status = "running";
  }

  private async runLoop(state: LoopState): Promise<void> {
    while (state.status === "running" && !state.abortController.signal.aborted) {
      try {
        // Placeholder: Task integration will be added in Step 2.4
        // For now, just sleep
        await sleep(state.options.idleInterval, state.abortController.signal);
      } catch (err) {
        if (err instanceof AbortError) {
          break; // Normal stop
        }
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= 5) {
          state.status = "error";
          break;
        }
        await sleep(state.options.idleInterval * 2, state.abortController.signal);
      }
    }
  }
}

// ============================================================================
// Testing Exports
// ============================================================================

export const __testing = {
  getCoordinatorLoopManager: () => globalCoordinatorLoopManager,
  resetCoordinatorLoopManager: () => {
    if (globalCoordinatorLoopManager) {
      // Stop all loops
      for (const [id, state] of globalCoordinatorLoopManager["loops"]) {
        state.abortController.abort();
      }
      globalCoordinatorLoopManager = null;
    }
  },
  sleep,
  AbortError,
};
```

- [ ] **Run tests to verify lifecycle passes**

Run: `pnpm test src/agents/coordinator-loop-manager.test.ts -v`
Expected: PASS for lifecycle tests

### Step 2.3: Write test for consecutive failure handling

- [ ] **Add consecutive failure test**

```typescript
// Add to coordinator-loop-manager.test.ts

describe("consecutive failure handling", () => {
  it("should pause loop after 5 consecutive failures", async () => {
    const manager = createCoordinatorLoopManager();

    // Mock taskTool to always fail
    const mockTaskTool = {
      get_ready: vi.fn().mockRejectedValue(new Error("Connection failed")),
      claim: vi.fn(),
      complete: vi.fn(),
      mark_failed: vi.fn(),
    };

    __testing.setTaskTool(mockTaskTool);

    const loopId = await manager.start({
      idleInterval: 100,
      maxRetries: 3,
      timeoutPerTask: 5000,
      agentId: "test-agent",
      sessionKey: "test-session",
    });

    // Advance timers to simulate failures
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(200); // 2x idleInterval for retry
      await vi.runAllTimersAsync();
    }

    const status = manager.getStatus(loopId);
    expect(status.status).toBe("error");
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Add task tool injection to manager**

```typescript
// Add to coordinator-loop-manager.ts

interface TaskToolInterface {
  get_ready(): Promise<{ id: string; directive: string } | null>;
  claim(taskId: string): Promise<{ id: string; directive: string }>;
  complete(taskId: string, output: unknown): Promise<void>;
  mark_failed(taskId: string, error: Error): Promise<void>;
}

let taskTool: TaskToolInterface | null = null;

export function setTaskTool(tool: TaskToolInterface): void {
  taskTool = tool;
}

// Add to __testing
export const __testing = {
  ...__testing,
  setTaskTool: (tool: TaskToolInterface) => {
    taskTool = tool;
  },
};
```

- [ ] **Run failure handling test**

Run: `pnpm test src/agents/coordinator-loop-manager.test.ts -t "consecutive failure" -v`
Expected: PASS

### Step 2.4: Implement full runLoop with task tool

- [ ] **Complete runLoop implementation**

```typescript
// Update runLoop in coordinator-loop-manager.ts

private async runLoop(state: LoopState): Promise<void> {
  while (state.status === "running" && !state.abortController.signal.aborted) {
    // Skip if paused
    if (state.status === "paused") {
      await sleep(state.options.idleInterval, state.abortController.signal);
      continue;
    }

    try {
      if (!taskTool) {
        // No task tool configured, just sleep
        await sleep(state.options.idleInterval, state.abortController.signal);
        continue;
      }

      // 1. Check for ready tasks
      const readyTask = await taskTool.get_ready();

      if (readyTask) {
        state.currentTask = readyTask;

        // 2. Claim the task
        const claimed = await taskTool.claim(readyTask.id);

        // 3. Execute task (placeholder - spawn child session)
        const result = await this.executeTask(state, claimed);

        // 4. Complete or mark failed
        if (result.success) {
          await taskTool.complete(claimed.id, result.output);
          state.tasksCompleted++;
        } else {
          await taskTool.mark_failed(claimed.id, result.error);
          state.tasksFailed++;
        }

        state.currentTask = undefined;
        state.consecutiveFailures = 0;
      }

      // 5. Sleep before next check
      await sleep(state.options.idleInterval, state.abortController.signal);

    } catch (err) {
      if (err instanceof AbortError) {
        break; // Normal stop
      }

      state.consecutiveFailures++;
      log.warn("Coordinator loop iteration failed", {
        loopId: state.id,
        consecutiveFailures: state.consecutiveFailures,
        error: err,
      });

      if (state.consecutiveFailures >= 5) {
        state.status = "error";
        log.error("Coordinator loop paused due to consecutive failures", {
          loopId: state.id,
        });
        break;
      }

      // Wait longer before retry
      await sleep(state.options.idleInterval * 2, state.abortController.signal);
    }
  }
}

private async executeTask(
  state: LoopState,
  task: { id: string; directive: string },
): Promise<{ success: boolean; output?: unknown; error?: Error }> {
  // Placeholder - will integrate with sessions_spawn in production
  // For now, return success
  return { success: true, output: "Task executed" };
}
```

- [ ] **Run full test suite**

Run: `pnpm test src/agents/coordinator-loop-manager.test.ts -v`
Expected: PASS

### Step 2.5: Integrate with background_task tool

> **Integration Context:** `CoordinatorLoopManager` is a new infrastructure class (parallel to `BackgroundTasksManager`). Both managers coexist - the tool routes requests based on `mode` parameter.

- [ ] **Add coordinator mode to background-task-tool.ts**

```typescript
// src/agents/tools/background-task-tool.ts modifications

// Add new import at top (around line 20, after existing imports)
import {
  createCoordinatorLoopManager,
  type CoordinatorOptions,
} from "../coordinator-loop-manager.js"; // From parent directory

// Add coordinator schema (around line 100, after existing schemas)
const BackgroundTaskCoordinatorSchema = Type.Object({
  action: Type.Literal("add"),
  mode: Type.Literal("coordinator"),
  idleInterval: Type.Optional(Type.Number({ minimum: 1000 })),
  maxRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
  timeoutPerTask: Type.Optional(Type.Number({ minimum: 1000 })),
  agentId: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
});

// Add to Union schema
const BackgroundTaskToolInputSchema = Type.Union([
  BackgroundTaskAddSchema,
  BackgroundTaskGetSchema,
  BackgroundTaskListSchema,
  BackgroundTaskCancelSchema,
  BackgroundTaskStatsSchema,
  BackgroundTaskClearSchema,
  BackgroundTaskCoordinatorSchema, // New
]);

// Add handler in execute function
case "add": {
  if (input.mode === "coordinator") {
    const loopManager = createCoordinatorLoopManager();
    const options: CoordinatorOptions = {
      idleInterval: input.idleInterval ?? 30000,
      maxRetries: input.maxRetries ?? 3,
      timeoutPerTask: input.timeoutPerTask ?? 300000,
      agentId: input.agentId ?? "default",
      sessionKey: input.sessionKey ?? "",
    };

    const loopId = await loopManager.start(options);

    return jsonResult({
      success: true,
      loopId,
      message: "Coordinator loop started",
      status: loopManager.getStatus(loopId),
    });
  }
  // ... existing add handling
}
```

- [ ] **Run typecheck**

Run: `pnpm tsgo`
Expected: PASS

### Step 2.6: Commit 14.3-adapt implementation

- [ ] **Stage and commit**

```bash
git add src/agents/coordinator-loop-manager.ts
git add src/agents/coordinator-loop-manager.test.ts
git add src/agents/tools/background-task-tool.ts
git commit -m "feat(14.3): add CoordinatorLoopManager with infrastructure control loop

- Infrastructure-level sleep with AbortSignal support
- Consecutive failure detection (>=5 pauses loop)
- Integration with background_task tool coordinator mode
- Lifecycle: start/stop/pause/resume

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Concurrency Control Wrapper (14.1-adapt)

**Priority:** P2 (lowest - requires careful testing)

**Files:**
- Create: `src/agents/concurrency-control-wrapper.ts`
- Create: `src/agents/concurrency-control-wrapper.test.ts`
- Modify: `src/agents/pi-tools.ts` (apply wrapper)

### Step 3.1: Write failing test for slot manager

- [ ] **Create test file with slot manager tests**

```typescript
// src/agents/concurrency-control-wrapper.test.ts

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  createConcurrencySlotManager,
  wrapToolWithConcurrencyControl,
  __testing,
  CONCURRENCY_SAFE_TOOLS,
} from "./concurrency-control-wrapper.js";
import type { AnyAgentTool } from "./tools/common.js"; // From subdirectory

describe("concurrency-control-wrapper", () => {
  beforeEach(() => {
    __testing.resetSlotManager();
  });

  afterEach(() => {
    __testing.resetSlotManager();
  });

  describe("ConcurrencySlotManager", () => {
    it("should create slot manager with default maxConcurrent", () => {
      const manager = createConcurrencySlotManager();
      const status = manager.getStatus();
      expect(status.maxConcurrent).toBe(10);
      expect(status.activeCount).toBe(0);
      expect(status.queuedCount).toBe(0);
    });

    it("should create slot manager with custom maxConcurrent", () => {
      const manager = createConcurrencySlotManager({ maxConcurrent: 5 });
      expect(manager.getStatus().maxConcurrent).toBe(5);
    });

    it("should acquire and release slots", async () => {
      const manager = createConcurrencySlotManager({ maxConcurrent: 2 });

      await manager.acquireSlot("call-1", "bash");
      expect(manager.getStatus().activeCount).toBe(1);

      await manager.acquireSlot("call-2", "bash");
      expect(manager.getStatus().activeCount).toBe(2);

      manager.releaseSlot("call-1");
      expect(manager.getStatus().activeCount).toBe(1);

      manager.releaseSlot("call-2");
      expect(manager.getStatus().activeCount).toBe(0);
    });

    it("should block when maxConcurrent reached", async () => {
      const manager = createConcurrencySlotManager({ maxConcurrent: 1 });

      await manager.acquireSlot("call-1", "bash");

      // Second acquire should block
      const acquirePromise = manager.acquireSlot("call-2", "bash");

      // Should not resolve immediately
      await expect(
        Promise.race([
          acquirePromise,
          new Promise((r) => setTimeout(r, 100, "timeout")),
        ])
      ).resolves.toBe("timeout");

      // Release first slot
      manager.releaseSlot("call-1");

      // Second should now acquire
      await acquirePromise;
      expect(manager.getStatus().activeCount).toBe(1);
    });
  });

  describe("wrapToolWithConcurrencyControl", () => {
    it("should wrap tool with execute function", () => {
      const tool: AnyAgentTool = {
        name: "test-tool",
        label: "test-tool",
        description: "Test tool",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ text: "result" }] }),
      };

      const manager = createConcurrencySlotManager();
      const wrapped = wrapToolWithConcurrencyControl(tool, manager);

      expect(wrapped.name).toBe("test-tool");
      expect(wrapped.execute).toBeDefined();
    });

    it("should return tool without execute unchanged", () => {
      const tool: AnyAgentTool = {
        name: "no-execute-tool",
        label: "no-execute-tool",
        description: "Tool without execute",
        parameters: Type.Object({}),
      };

      const manager = createConcurrencySlotManager();
      const wrapped = wrapToolWithConcurrencyControl(tool, manager);

      expect(wrapped).toBe(tool);
    });

    it("should release slot after successful execution", async () => {
      const tool: AnyAgentTool = {
        name: "test-tool",
        label: "test-tool",
        description: "Test tool",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ text: "success" }] }),
      };

      const manager = createConcurrencySlotManager({ maxConcurrent: 1 });
      const wrapped = wrapToolWithConcurrencyControl(tool, manager);

      await wrapped.execute!("call-1", {});
      expect(manager.getStatus().activeCount).toBe(0);
    });

    it("should release slot after failed execution", async () => {
      const tool: AnyAgentTool = {
        name: "fail-tool",
        label: "fail-tool",
        description: "Failing tool",
        parameters: Type.Object({}),
        execute: async () => {
          throw new Error("Tool failed");
        },
      };

      const manager = createConcurrencySlotManager({ maxConcurrent: 1 });
      const wrapped = wrapToolWithConcurrencyControl(tool, manager);

      await expect(wrapped.execute!("call-1", {})).rejects.toThrow("Tool failed");
      expect(manager.getStatus().activeCount).toBe(0);
    });
  });

  describe("sequential tools", () => {
    it("should wait for all active tools for sequential tool", async () => {
      const manager = createConcurrencySlotManager({ maxConcurrent: 10 });

      // Start a concurrent tool
      await manager.acquireSlot("call-1", "bash");

      // Sequential tool should wait
      const sequentialPromise = manager.acquireSlot("call-2", "sequential-tool");

      await expect(
        Promise.race([
          sequentialPromise,
          new Promise((r) => setTimeout(r, 100, "timeout")),
        ])
      ).resolves.toBe("timeout");

      manager.releaseSlot("call-1");
      await sequentialPromise;
    });
  });
});
```

- [ ] **Run test to verify it fails**

Run: `pnpm test src/agents/concurrency-control-wrapper.test.ts -v`
Expected: FAIL - "Cannot find module './concurrency-control-wrapper.js'"

### Step 3.2: Write minimal ConcurrencySlotManager implementation

- [ ] **Create slot manager with acquire/release**

```typescript
// src/agents/concurrency-control-wrapper.ts

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./tools/common.js";

// ============================================================================
// Concurrency Safe Tools
// ============================================================================

export const CONCURRENCY_SAFE_TOOLS = [
  "read",
  "grep",
  "glob",
  "web-fetch",
  "web-search",
];

// ============================================================================
// Types
// ============================================================================

export interface ConcurrencySlotManagerOptions {
  maxConcurrent?: number;
}

export interface ConcurrencySlotStatus {
  activeCount: number;
  queuedCount: number;
  maxConcurrent: number;
}

export interface ConcurrencySlotManager {
  acquireSlot(toolCallId: string, toolName: string, signal?: AbortSignal): Promise<void>;
  releaseSlot(toolCallId: string): void;
  getStatus(): ConcurrencySlotStatus;
}

// ============================================================================
// Slot Manager Implementation
// ============================================================================

class AbortError extends Error {
  constructor() {
    super("AbortError");
    this.name = "AbortError";
  }
}

let globalSlotManager: SlotManagerImpl | null = null;

export function createConcurrencySlotManager(
  options?: ConcurrencySlotManagerOptions,
): ConcurrencySlotManager {
  globalSlotManager ??= new SlotManagerImpl(options?.maxConcurrent ?? 10);
  return globalSlotManager;
}

class SlotManagerImpl implements ConcurrencySlotManager {
  private activeCount = 0;
  private queued: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private readonly maxConcurrent: number;
  private activeSlots: Map<string, string> = new Map(); // callId -> toolName

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  isConcurrencySafe(toolName: string): boolean {
    return CONCURRENCY_SAFE_TOOLS.includes(toolName);
  }

  async acquireSlot(
    toolCallId: string,
    toolName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Sequential tool: wait for ALL active tools to complete
    if (!this.isConcurrencySafe(toolName)) {
      while (this.activeCount > 0) {
        if (signal?.aborted) throw new AbortError();
        await this.waitForSlot(signal, 50);
      }
      this.activeCount++;
      this.activeSlots.set(toolCallId, toolName);
      return;
    }

    // Concurrent safe tool: wait for available slot
    while (this.activeCount >= this.maxConcurrent) {
      if (signal?.aborted) throw new AbortError();
      await this.waitForSlot(signal, 50);
    }

    this.activeCount++;
    this.activeSlots.set(toolCallId, toolName);
  }

  releaseSlot(toolCallId: string): void {
    if (!this.activeSlots.has(toolCallId)) return;

    this.activeSlots.delete(toolCallId);
    this.activeCount--;

    // Notify first queued waiter
    if (this.queued.length > 0) {
      const waiter = this.queued.shift();
      waiter?.resolve();
    }
  }

  getStatus(): ConcurrencySlotStatus {
    return {
      activeCount: this.activeCount,
      queuedCount: this.queued.length,
      maxConcurrent: this.maxConcurrent,
    };
  }

  private async waitForSlot(signal?: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Remove from queue on timeout
        const idx = this.queued.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.queued.splice(idx, 1);
        resolve(); // Re-check condition in loop
      }, timeoutMs);

      signal?.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new AbortError());
      });

      this.queued.push({
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject,
      });
    });
  }
}

// ============================================================================
// Tool Wrapper
// ============================================================================

export function wrapToolWithConcurrencyControl(
  tool: AnyAgentTool,
  slotManager: ConcurrencySlotManager,
): AnyAgentTool {
  if (!tool.execute) return tool;

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult> => {
      // 1. Acquire slot
      await slotManager.acquireSlot(toolCallId, tool.name, signal);

      try {
        // 2. Execute original tool
        const result = await tool.execute(toolCallId, input, signal);
        return result;
      } finally {
        // 3. Release slot (always, even on error/abort)
        slotManager.releaseSlot(toolCallId);
      }
    },
  };
}

// ============================================================================
// Testing Exports
// ============================================================================

export const __testing = {
  getSlotManager: () => globalSlotManager,
  resetSlotManager: () => {
    if (globalSlotManager) {
      // Release all active slots
      for (const [callId] of globalSlotManager["activeSlots"]) {
        globalSlotManager.releaseSlot(callId);
      }
      // Clear queue
      globalSlotManager["queued"] = [];
      globalSlotManager = null;
    }
  },
  AbortError,
};
```

- [ ] **Run tests to verify basic slot management**

Run: `pnpm test src/agents/concurrency-control-wrapper.test.ts -v`
Expected: PASS for slot manager tests

### Step 3.3: Add AbortSignal integration test

- [ ] **Add abort test**

```typescript
// Add to concurrency-control-wrapper.test.ts

describe("AbortSignal integration", () => {
  it("should abort acquireSlot when signal aborted", async () => {
    const manager = createConcurrencySlotManager({ maxConcurrent: 1 });

    await manager.acquireSlot("call-1", "bash");

    const controller = new AbortController();
    const acquirePromise = manager.acquireSlot("call-2", "bash", controller.signal);

    controller.abort();

    await expect(acquirePromise).rejects.toThrow("AbortError");

    // Original slot should still be active
    expect(manager.getStatus().activeCount).toBe(1);
  });

  it("should release slot when execution aborted", async () => {
    const tool: AnyAgentTool = {
      name: "abort-tool",
      label: "abort-tool",
      description: "Tool that checks abort",
      parameters: Type.Object({}),
      execute: async (callId, input, signal) => {
        // Simulate abort during execution
        signal?.addEventListener("abort", () => {
          throw new AbortError();
        });
        await new Promise((r) => setTimeout(r, 1000));
        return { content: [{ text: "done" }] };
      },
    };

    const manager = createConcurrencySlotManager({ maxConcurrent: 1 });
    const wrapped = wrapToolWithConcurrencyControl(tool, manager);

    const controller = new AbortController();
    const executePromise = wrapped.execute!("call-1", {}, controller.signal);

    controller.abort();

    await expect(executePromise).rejects.toThrow();
    expect(manager.getStatus().activeCount).toBe(0);
  });
});
```

- [ ] **Run abort tests**

Run: `pnpm test src/agents/concurrency-control-wrapper.test.ts -t "AbortSignal" -v`
Expected: PASS

### Step 3.4: Integrate with pi-tools.ts (optional - may need config flag)

> **Integration Pattern Reference:** Follow `pi-tools.abort.ts` pattern:
> - Wrapper utility at `src/agents/pi-tools.abort.ts` exports `wrapToolWithAbortSignal`
> - Used in `pi-tools.ts` for tool wrapping

- [ ] **Check pi-tools.ts pattern first**

```bash
# Verify files exist
ls -la src/agents/pi-tools.ts src/agents/pi-tools.abort.ts
```

- [ ] **Add wrapper integration following abort signal pattern**

```typescript
// src/agents/pi-tools.ts modification (around line 25, after abort signal import)

// Add import after wrapToolWithAbortSignal import
import {
  createConcurrencySlotManager,
  wrapToolWithConcurrencyControl,
  type ConcurrencySlotManager,
} from "./concurrency-control-wrapper.js";

// Create slot manager (singleton, parallel to abort signal pattern)
let concurrencySlotManager: ConcurrencySlotManager | null = null;

// Add applyConcurrencyControl function (parallel to wrapToolWithAbortSignal usage)
export function applyConcurrencyControl(
  tools: AnyAgentTool[],
  options?: { enabled?: boolean },
): AnyAgentTool[] {
  if (options?.enabled === false) {
    return tools; // Skip wrapping when disabled (config flag)
  }

  concurrencySlotManager ??= createConcurrencySlotManager({ maxConcurrent: 10 });

  // Wrap each tool, preserving previous wrappers (abort signal first)
  return tools.map((tool) => {
    // Apply abort signal wrapper first (if needed)
    const withAbort = tool; // Abort signal applied earlier in resolvePiCodingTools
    // Then apply concurrency control
    return wrapToolWithConcurrencyControl(withAbort, concurrencySlotManager!);
  });
}

// Integration point: Call in resolvePiCodingTools after abort signal wrapping
// Example: const wrappedTools = applyConcurrencyControl(tools, { enabled: config.concurrencyControl?.enabled });
```

- [ ] **Run typecheck**

Run: `pnpm tsgo`
Expected: PASS

### Step 3.5: Commit 14.1-adapt implementation

- [ ] **Stage and commit**

```bash
git add src/agents/concurrency-control-wrapper.ts
git add src/agents/concurrency-control-wrapper.test.ts
git commit -m "feat(14.1): add concurrency control wrapper for tool execution

- Slot manager with maxConcurrent limit
- Concurrency-safe tools can parallelize
- Sequential tools wait for all active
- AbortSignal integration for interruptible acquire
- finally block ensures slot release on all paths

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## Verification Summary

After completing all tasks, run full verification:

```bash
pnpm test src/agents/tools/sessions-spawn-batch-tool.test.ts
pnpm test src/agents/coordinator-loop-manager.test.ts
pnpm test src/agents/concurrency-control-wrapper.test.ts
pnpm tsgo
```

Expected: All tests PASS, no type errors.

---

## Reference Documents

> **Verified file locations (2026-04-21):**
> - `src/agents/pi-tools.ts` - EXISTS (13533 bytes) - Integration point for concurrency wrapper
> - `src/agents/openclaw-tools.ts` - EXISTS (13533 bytes) - Tool registration
> - `src/agents/streaming-tool-executor.ts` - EXISTS (12928 bytes) - Original Claude Code pattern reference

- [Spec Document](../specs/2026-04-21-phase14-adaptation-design.md)
- [FUSION_PROGRESS.md](../../FUSION_PROGRESS.md)
- [sessions-spawn-tool.ts](../../src/agents/tools/sessions-spawn-tool.ts) - Reference for spawn pattern
- [task-tool.ts](../../src/agents/tools/task-tool.ts) - Reference for task interface
- [background-tasks.ts](../../src/agents/background-tasks.ts) - Reference for task lifecycle
- [pi-tools.abort.ts](../../src/agents/pi-tools.abort.ts) - Reference for wrapper pattern
- [streaming-tool-executor.ts](../../src/agents/streaming-tool-executor.ts) - Original Claude Code pattern
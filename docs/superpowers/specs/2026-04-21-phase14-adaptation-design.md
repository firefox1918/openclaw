# Phase 14 适配版设计文档

> **创建时间**: 2026-04-21
> **目标**: 重新设计 StreamingToolExecutor、Fork Cache Optimization、Coordinator 三个模块，使其适配 OpenClaw 现有架构
> **原则**: 不修改 OpenClaw 核心代码（run.ts、SessionManager），通过外围适配实现功能

---

## 背景

原始 Phase 10-13 模块来自 Claude Code 的 12 层 Harness 机制，设计时假设了 Claude Code 的特定架构：

| 模块                    | Claude Code 设计假设          | OpenClaw 实际架构                |
| ----------------------- | ----------------------------- | -------------------------------- |
| StreamingToolExecutor   | 工具执行在 Tool.ts 自己实现   | 工具执行由 SessionManager 库处理 |
| Fork Cache Optimization | 批量 Fork 子 Agent 是常见场景 | sessions_spawn 是单次调用 API    |
| Coordinator             | Agent 完成后有空闲状态循环    | Agent 完成后直接 return          |

**适配策略**: 在 OpenClaw 的外围层（钩子、工具、后台任务）实现相同能力，而非修改核心架构。

---

## 适配版 14.1: StreamingToolExecutor → ConcurrencyControlHook

### 设计目标

在 OpenClaw 的工具包装层实现并发控制，而非修改 SessionManager 内部逻辑。

**设计变更 (v2)**: 原 design 在 `before-tool-call.ts` 钩子层插入并发控制，但发现：

- 钩子系统返回 `HookOutcome = { blocked: true/false }`，不支持"wait"状态
- 钩子无工具执行后的回调机制（无法调用 `onToolComplete`）

**新方案**: 在工具包装层实现，包装每个工具的 `execute` 函数。

### 核心概念

```
Claude Code: 在 StreamingToolExecutor 中管理并发
OpenClaw 适配 (v2): 在工具包装层管理并发，包装 execute 函数
```

### 架构设计 (v2)

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw 工具执行流程                      │
├─────────────────────────────────────────────────────────────┤
│  SessionManager.prompt()                                    │
│       ↓                                                      │
│  工具调用识别                                                 │
│       ↓                                                      │
│  ┌─────────────────────────────────────────────┐            │
│  │ wrapToolWithConcurrencyControl (新增包装层)   │            │
│  │                                               │            │
│  │  execute 函数包装流程:                        │            │
│  │  1. acquireSlot(toolName) → 等待获取槽位      │            │
│  │  2. 执行原始 execute 函数                     │            │
│  │  3. releaseSlot() → 完成后释放槽位            │            │
│  │  4. 返回结果                                  │            │
│  └─────────────────────────────────────────────┘            │
│       ↓                                                      │
│  工具实际执行                                                 │
└─────────────────────────────────────────────────────────────┘
```

### 接口设计 (v2)

```typescript
// src/agents/concurrency-control-wrapper.ts

interface ConcurrencySlotManager {
  // 获取执行槽位 (阻塞直到可用)
  acquireSlot(toolCallId: string, toolName: string, signal?: AbortSignal): Promise<void>;

  // 释放槽位
  releaseSlot(toolCallId: string): void;

  // 获取当前状态
  getStatus(): {
    activeCount: number;
    queuedCount: number;
    maxConcurrent: number;
  };
}

// 工具包装函数 (v3 - 正确传递 AbortSignal)
function wrapToolWithConcurrencyControl(
  tool: AnyAgentTool,
  slotManager: ConcurrencySlotManager,
): AnyAgentTool {
  if (!tool.execute) return tool;

  return {
    ...tool,
    execute: async (toolCallId: string, input: unknown, signal?: AbortSignal) => {
      // 1. 等待获取槽位 (传递 signal 支持中断等待)
      await slotManager.acquireSlot(toolCallId, tool.name, signal);

      try {
        // 2. 执行原始工具 (传递 signal)
        const result = await tool.execute(toolCallId, input, signal);
        return result;
      } finally {
        // 3. 完成后释放槽位 (finally 保证所有路径都释放)
        slotManager.releaseSlot(toolCallId);
      }
    },
  };
}
```

**注意**: `AnyAgentTool` 的 `execute` 函数签名需要支持可选 `AbortSignal` 参数。参考 `pi-tools.abort.ts` 中的 `wrapToolWithAbortSignal` 模式。

### 槽位获取算法

```typescript
async acquireSlot(toolCallId: string, toolName: string, signal?: AbortSignal): Promise<void> {
  // 并发安全工具: 等待直到有空闲槽位
  if (this.isConcurrencySafe(toolName)) {
    while (this.activeCount >= this.maxConcurrent) {
      // 检查 abort signal
      if (signal?.aborted) throw new AbortError();

      // 等待槽位释放信号
      await this.waitForSlotRelease(signal, 100);
    }
    this.activeCount++;
    return;
  }

  // 顺序工具: 等待所有活跃工具完成
  while (this.activeCount > 0) {
    if (signal?.aborted) throw new AbortError();
    await this.waitForSlotRelease(signal, 100);
  }
  this.activeCount++;
}
```

### 集成点 (v3)

工具包装在 `src/agents/pi-tools.ts` 中应用，与现有的 `wrapToolWithAbortSignal` 模式一致：

```typescript
// src/agents/pi-tools.ts (参考 pi-tools.abort.ts 的模式)

import {
  createConcurrencySlotManager,
  wrapToolWithConcurrencyControl,
} from "./concurrency-control-wrapper.js";

// 创建槽位管理器 (单例)
const slotManager = createConcurrencySlotManager({ maxConcurrent: 10 });

// 包装所有工具 (在 wrapToolWithAbortSignal 之后或合并)
const wrappedTools = tools.map((tool) => {
  // 先包装 abort signal (如果需要)
  const withAbort = wrapToolWithAbortSignal(tool);
  // 再包装并发控制
  return wrapToolWithConcurrencyControl(withAbort, slotManager);
});

// 注意: pi-tools.ts 是 resolvePiCodingTools 函数所在位置
// SessionManager 使用 pi-tools 提供的工具集
```

### 错误处理 (v3 - 简化)

`finally` 块保证所有路径都释放槽位，无需额外的 catch 处理：

```typescript
// AbortSignal 取消时的处理在 acquireSlot 内部
// waitForSlotRelease 循环中检查 signal.aborted

// 工具执行失败时的处理由 finally 自动覆盖
// 无需手动 catch + releaseSlot

// 总结: finally 块统一处理 success/error/abort 三种路径
```

### 文件清单

| 文件                                             | 操作 | 说明                      |
| ------------------------------------------------ | ---- | ------------------------- |
| `src/agents/concurrency-control-wrapper.ts`      | 新建 | 槽位管理器 + 工具包装函数 |
| `src/agents/concurrency-control-wrapper.test.ts` | 新建 | 测试文件                  |
| `src/agents/pi-tools.ts`                         | 修改 | 应用工具包装              |

### 降级方案

如果包装方案不理想，可配置关闭：

```typescript
const config = { concurrencyControl: { enabled: false } };
// enabled=false 时跳过包装，保持原有行为

---

## 适配版 14.2: Fork Cache Optimization → sessions_spawn_batch

### 设计目标

创建新的 `sessions_spawn_batch` 工具，支持一次 spawn 多个子 Agent，并应用缓存优化。

### 核心概念

```

Claude Code: 批量 Fork 时使用统一 placeholder
OpenClaw 适配: 批量 spawn 时使用统一消息前缀

```

### 架构设计

```

┌─────────────────────────────────────────────────────────────┐
│ sessions_spawn_batch 工具流程 │
├─────────────────────────────────────────────────────────────┤
│ 用户调用: sessions_spawn_batch({ │
│ tasks: ["搜索文件A", "分析代码B", "测试功能C"], │
│ sharedContext: { workspaceDir, sessionKey } │
│ }) │
│ ↓ │
│ ┌─────────────────────────────────┐ │
│ │ Fork Cache Optimizer │ │
│ │ - 生成统一 boilerplate │ │
│ │ - 每个任务只有 directive 不同 │ │
│ │ - 计算缓存节省估计 │ │
│ └─────────────────────────────────┘ │
│ ↓ │
│ 批量调用 Gateway sessions.spawn (并行) │
│ ↓ │
│ 返回: { │
│ children: [{ sessionKey, runId, task }...], │
│ estimatedCacheSavings: 1500 tokens │
│ } │
└─────────────────────────────────────────────────────────────┘

````

### 工具 Schema

```typescript
const SessionsSpawnBatchSchema = Type.Object({
  // 任务列表 (2-10 个)
  tasks: Type.Array(
    Type.Object({
      directive: Type.String({ minLength: 1, maxLength: 500 }),
      label: Type.Optional(Type.String()),
    }),
    { minItems: 2, maxItems: 10 }
  ),

  // 共享上下文 (所有子 Agent 共享)
  sharedContext: Type.Object({
    agentId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    workspaceDir: Type.Optional(Type.String()),
  }),

  // 执行模式
  mode: Type.Optional(Type.String()), // "parallel" | "sequential", 默认 parallel

  // 完成后是否自动清理
  cleanup: Type.Optional(Type.String()), // "delete" | "keep"
});
````

### 统一消息模板

```typescript
// 所有批量 spawn 的子 Agent 共享此模板
const BATCH_SPAWN_BOILERPLATE = `
[Batch Subagent Context]
You are part of a batch spawn operation.
- Depth: shared across batch
- Results auto-announce to requester
- Do not busy-poll for status

[Shared Context]
Working directory: ${sharedContext.workspaceDir}
Session: ${sharedContext.sessionKey}

[Your Task]
${uniqueDirective}
`;

// 只有 uniqueDirective 部分不同，其余完全相同
// 这样 API provider 可以识别相同的文本前缀并使用 Prompt Cache
```

### 缓存节省计算算法

```typescript
function calculateCacheSavings(tasks: BatchTask[], sharedContext: SharedContext): number {
  // 计算共享前缀长度
  const boilerplateTokens = estimateTokens(BATCH_SPAWN_BOILERPLATE_TEMPLATE);

  // 计算共享上下文 tokens
  const contextTokens = estimateTokens(`
Working directory: ${sharedContext.workspaceDir}
Session: ${sharedContext.sessionKey}
  `);

  // 缓存节省 = (共享前缀 tokens) × (任务数量 - 1)
  // 第一个请求无缓存节省，后续请求复用缓存
  const sharedTokens = boilerplateTokens + contextTokens;
  const savings = sharedTokens * (tasks.length - 1);

  return Math.ceil(savings);
}

// Token 估算: 约 4 字符 = 1 token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// 注意: 这是一个粗略估算值，用于缓存节省预估
// 实际 token 数量取决于:
// - Provider 的 tokenizer (Anthropic Claude vs OpenAI GPT 使用不同分词器)
// - Unicode/多字节字符处理
// - 模板变量插值效果
//
// 此估算继承 fork-cache-optimization.ts 的实现，保持一致性
// 如果需要精确值用于计费决策，应使用 provider-specific tokenizer
```

### 执行策略

```typescript
// 默认并行执行，但有错误隔离
async executeBatchSpawn(tasks: BatchTask[], sharedContext: SharedContext, mode: "parallel" | "sequential") {
  const results: SpawnResult[] = [];
  const errors: SpawnError[] = [];

  if (mode === "parallel") {
    // 并行执行，收集所有结果（包括失败）
    const promises = tasks.map(task => spawnChild(task, sharedContext).catch(e => ({ error: e, task })));
    const outcomes = await Promise.allSettled(promises);

    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        errors.push({ task: outcome.reason.task, error: outcome.reason.error });
      }
    }
  } else {
    // 顺序执行，失败时停止后续执行
    for (const task of tasks) {
      try {
        const result = await spawnChild(task, sharedContext);
        results.push(result);
      } catch (e) {
        errors.push({ task, error: e });
        break; // 顺序模式: 遇到错误停止
      }
    }
  }

  return {
    children: results,
    errors,
    successCount: results.length,
    failureCount: errors.length,
    estimatedCacheSavings: calculateCacheSavings(tasks, sharedContext),
  };
}
```

### 错误处理策略

| 错误场景         | 处理方式                                      |
| ---------------- | --------------------------------------------- |
| 部分失败 (并行)  | 返回成功列表 + 错误列表，用户自行决定是否重试 |
| 首个失败 (顺序)  | 停止后续执行，返回错误                        |
| Gateway 连接失败 | 返回整体错误，不创建任何子 Session            |
| 单个 spawn 超时  | 标记该任务超时错误，其他任务继续              |

### 集成点

创建 `src/agents/tools/sessions-spawn-batch-tool.ts`，注册到 `openclaw-tools.ts`。

### 文件清单

| 文件                                                 | 操作 | 说明                          |
| ---------------------------------------------------- | ---- | ----------------------------- |
| `src/agents/tools/sessions-spawn-batch-tool.ts`      | 新建 | 批量 spawn 工具实现           |
| `src/agents/tools/sessions-spawn-batch-tool.test.ts` | 新建 | 测试文件                      |
| `src/agents/fork-cache-optimization.ts`              | 修改 | 添加 batch spawn 消息构建函数 |
| `src/agents/openclaw-tools.ts`                       | 修改 | 注册新工具                    |

---

## 适配版 14.3: Coordinator → CoordinatorLoopManager

### 设计目标

在基础设施层实现 Coordinator 控制循环，而非依赖 Agent directive 执行 sleep 操作。

**设计变更 (v2)**: 原 design 使用 Agent directive 引导 Agent 执行循环（包括 sleep），但发现：

- Agent 无法可靠执行定时 sleep 操作（模型行为不可预测）
- Agent 循环逻辑难以监控和控制
- 错误处理和恢复需要基础设施支持

**新方案**: 创建 `CoordinatorLoopManager` 管理控制循环，每次循环创建临时 Agent session 执行单个任务。

### 核心概念

```
Claude Code: Agent 完成后进入空闲循环，Coordinator 自动认领任务
OpenClaw 适配 (v2): CoordinatorLoopManager 在基础设施层管理循环，临时 Agent 执行单任务
```

### 架构设计 (v2)

```
┌─────────────────────────────────────────────────────────────┐
│              CoordinatorLoopManager (基础设施层)              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  用户启动 Coordinator:                                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ background_task({                                     │   │
│  │   action: "add",                                      │   │
│  │   mode: "coordinator",                                │   │
│  │   idleInterval: 30000,                                │   │
│  │   maxRetries: 3                                       │   │
│  │ })                                                    │   │
│  └──────────────────────────────────────────────────────┘   │
│       ↓                                                      │
│  ┌──────────────────────────────────────────────┐           │
│  │ CoordinatorLoopManager (新增基础设施类)         │           │
│  │                                                │           │
│  │ 控制循环 (JavaScript 定时器 + Promise):        │           │
│  │   1. task.get_ready → 检查待处理任务           │           │
│  │   2. 如果有任务 → task.claim                   │           │
│  │   3. spawnChildSession() → 创建临时 Agent      │           │
│  │   4. 执行任务 directive                        │           │
│  │   5. task.complete                            │           │
│  │   6. await sleep(idleInterval) ← 基础设施 sleep │           │
│  │   7. 重复                                      │           │
│  │                                                │           │
│  │ 错误处理:                                      │           │
│  │   - 任务执行失败 → task.mark_failed            │           │
│  │   - Agent 超时 → abort + cleanup               │           │
│  │   - 连续失败 → 暂停循环 + 通知用户              │           │
│  └──────────────────────────────────────────────────────┘   │
│       ↓                                                      │
│  用户监控:                                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ background_task.stats → 查看协调状态                 │   │
│  │ background_task.get(id) → 查看特定任务               │   │
│  │ background_task.cancel(id) → 停止协调                │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### CoordinatorLoopManager 接口设计 (v2)

```typescript
// src/agents/coordinator-loop-manager.ts

interface CoordinatorLoopManager {
  // 启动协调循环
  start(options: CoordinatorOptions): Promise<string>; // 返回 loopId

  // 停止协调循环
  stop(loopId: string): Promise<void>;

  // 获取循环状态
  getStatus(loopId: string): CoordinatorStatus;

  // 暂停/恢复
  pause(loopId: string): Promise<void>;
  resume(loopId: string): Promise<void>;
}

interface CoordinatorOptions {
  idleInterval: number; // 检查间隔 (ms)
  maxRetries: number; // 单任务最大重试次数
  timeoutPerTask: number; // 单任务超时 (ms)
  agentId: string; // 执行任务的 Agent ID
  sessionKey: string; // 父 Session Key
}

interface CoordinatorStatus {
  loopId: string;
  status: "running" | "paused" | "stopped" | "error";
  tasksCompleted: number;
  tasksFailed: number;
  currentTask?: TaskInfo;
  lastCheckTime: Date;
  consecutiveFailures: number;
}
```

### 控制循环实现 (v2)

```typescript
class CoordinatorLoopManagerImpl implements CoordinatorLoopManager {
  private loops: Map<string, LoopState> = new Map();
  private taskTool: TaskToolInterface; // 从 OpenClaw 工具注入

  async start(options: CoordinatorOptions): Promise<string> {
    const loopId = crypto.randomUUID(); // 使用标准 UUID 生成
    const state: LoopState = {
      id: loopId,
      options,
      status: "running",
      abortController: new AbortController(),
    };
    this.loops.set(loopId, state);

    // 启动后台循环 (不阻塞)
    this.runLoop(state).catch((err) => this.handleLoopError(state, err));

    return loopId;
  }

  private async runLoop(state: LoopState): Promise<void> {
    while (state.status === "running" && !state.abortController.signal.aborted) {
      try {
        // 1. 检查待处理任务
        const readyTask = await this.taskTool.get_ready();

        if (readyTask) {
          // 2. 认领任务
          const claimed = await this.taskTool.claim(readyTask.id);

          // 3. 创建临时 Agent session 执行任务
          const result = await this.spawnAndExecute(state, claimed);

          // 4. 完成任务
          if (result.success) {
            await this.taskTool.complete(claimed.id, result.output);
            state.tasksCompleted++;
          } else {
            await this.taskTool.mark_failed(claimed.id, result.error);
            state.tasksFailed++;
          }

          state.consecutiveFailures = 0;
        }

        // 5. 基础设施层 sleep (可靠)
        await sleep(state.options.idleInterval, state.abortController.signal);
      } catch (err) {
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= 5) {
          // 连续失败 5 次，暂停循环
          state.status = "error";
          this.notifyUser(state, err);
          break;
        }
        // 等待更长时间后重试
        await sleep(state.options.idleInterval * 2, state.abortController.signal);
      }
    }
  }

  private async spawnAndExecute(state: LoopState, task: ClaimedTask): Promise<TaskResult> {
    // 创建临时子 Agent session
    const childSession = await this.sessionsSpawn({
      directive: task.directive,
      agentId: state.options.agentId,
      timeout: state.options.timeoutPerTask,
    });

    // 等待子 Agent 完成
    const result = await this.waitForCompletion(childSession, state.options.timeoutPerTask);

    return result;
  }
}

// 基础设施层 sleep (可中断)
// 导出位置: src/agents/utils/sleep.ts 或使用现有 utils
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new AbortError());
    });
  });
}
```

### Task Tool 接口依赖 (v2)

`CoordinatorLoopManager` 需要调用 Task 工具的方法：

```typescript
// 参考 coordinator.ts 中的 CoordinatorTaskStore 接口
interface TaskToolInterface {
  get_ready(): Promise<TaskInfo | null>;
  claim(taskId: string): Promise<ClaimedTask>;
  complete(taskId: string, output: unknown): Promise<void>;
  mark_failed(taskId: string, error: Error): Promise<void>;
}

// CoordinatorLoopManager 通过依赖注入获取 taskTool
// 在 background_task 工具 execute 时传入
```

**依赖来源**: 使用 OpenClaw 的 `task` 工具（已注册在 `openclaw-tools.ts`），通过工具执行器调用。

````

### 单任务 Directive 模板 (v2)

CoordinatorLoopManager 创建的临时 Agent 只需要执行单个任务，directive 简化为：

```typescript
const SINGLE_TASK_DIRECTIVE_TEMPLATE = `
[Single Task Execution]
Execute the following task and report the result.

Task: ${taskDirective}

Rules:
- Complete the task fully before returning
- Report progress if task is long-running
- Return a clear summary of what was done

Begin execution now.
`;
````

### background_task 工具扩展 (v2)

添加 coordinator 模式到 background_task 工具：

```typescript
// background-task-tool.ts 扩展

const BackgroundTaskToolSchema = Type.Object({
  action: Type.String(), // "add" | "get" | "list" | "cancel" | "stats" | "clear"

  // coordinator 模式参数
  mode: Type.Optional(Type.String()), // "default" | "coordinator"
  idleInterval: Type.Optional(Type.Number()), // coordinator 检查间隔 (ms)
  maxRetries: Type.Optional(Type.Number()), // 单任务重试次数
  timeoutPerTask: Type.Optional(Type.Number()), // 单任务超时 (ms)

  // 其他参数...
});

// execute 函数扩展
async execute(toolCallId: string, input: BackgroundTaskInput) {
  if (input.action === "add" && input.mode === "coordinator") {
    // 使用 CoordinatorLoopManager
    const loopManager = getCoordinatorLoopManager();
    const loopId = await loopManager.start({
      idleInterval: input.idleInterval ?? 30000,
      maxRetries: input.maxRetries ?? 3,
      timeoutPerTask: input.timeoutPerTask ?? 300000,
      agentId: input.agentId ?? "default",
      sessionKey: input.sessionKey ?? "",
    });

    return {
      success: true,
      loopId,
      message: "Coordinator loop started",
    };
  }
  // ... 其他 action 处理
}
```

### 错误处理策略 (v2)

| 错误场景            | 处理方式                                   |
| ------------------- | ------------------------------------------ |
| 单任务执行失败      | task.mark_failed，继续下一个任务           |
| Agent 超时          | abort session，task.mark_failed，清理资源  |
| task.get_ready 失败 | 记录错误，等待 2×idleInterval 后重试       |
| 连续失败 ≥ 5 次     | 暂停循环，状态设为 "error"，通知用户       |
| 用户 cancel         | abort signal，清理所有活跃任务             |
| spawnChild 失败     | task.mark_failed，等待 idleInterval 后重试 |

### 文件清单 (v2)

| 文件                                            | 操作     | 说明                      |
| ----------------------------------------------- | -------- | ------------------------- |
| `src/agents/coordinator-loop-manager.ts`        | 新建     | 控制循环管理器实现        |
| `src/agents/coordinator-loop-manager.test.ts`   | 新建     | 测试文件                  |
| `src/agents/tools/background-task-tool.ts`      | 修改     | 添加 coordinator 模式支持 |
| `src/agents/tools/background-task-tool.test.ts` | 修改     | 添加 coordinator 模式测试 |
| `src/agents/openclaw-tools.ts`                  | 无需修改 | 已有 background_task 工具 |

---

## 实现计划

### Phase 14 适配版任务清单 (v2)

| 任务       | 目标文件                       | 预估工作量 | 优先级 | 设计版本              |
| ---------- | ------------------------------ | ---------- | ------ | --------------------- |
| 14.1-adapt | concurrency-control-wrapper.ts | 0.5 天     | P2     | v2 (工具包装层)       |
| 14.2-adapt | sessions-spawn-batch-tool.ts   | 1 天       | P1     | v1 (批量 spawn)       |
| 14.3-adapt | coordinator-loop-manager.ts    | 1 天       | P1     | v2 (基础设施控制循环) |

**推荐顺序**: 14.2-adapt → 14.3-adapt → 14.1-adapt

原因：

1. 14.2-adapt 价值最大（批量 spawn + 缓存优化），设计稳定
2. 14.3-adapt 设计变更为 v2（基础设施控制循环），需要完整实现
3. 14.1-adapt 需要修改工具包装层，需谨慎测试

### 14.3-adapt 设计变更说明 (v2)

原设计依赖 Agent directive 执行循环（包括 sleep），存在以下问题：

- Agent 无法可靠执行定时 sleep（模型行为不可预测）
- 循环逻辑难以监控和中断
- 错误恢复需要基础设施支持

新设计使用 `CoordinatorLoopManager` 在基础设施层管理：

- JavaScript 定时器 + Promise 实现可靠的 sleep
- AbortSignal 支持中断和清理
- 连续失败检测和自动暂停
- 每次循环创建临时 Agent session 执行单任务

---

## 验收标准

### 14.1-adapt 验收标准 (v2)

- 工具包装层正确管理并发槽位
- 并发安全工具可并行执行，顺序工具串行执行
- 可配置最大并发数
- 测试覆盖并发、顺序、等待三种情况

### 14.2-adapt 验收标准

- sessions_spawn_batch 工具支持 2-10 个任务批量 spawn
- 所有子 Agent 使用统一消息模板（缓存优化）
- 返回缓存节省估算
- 测试覆盖批量创建、缓存计算

### 14.3-adapt 验收标准 (v2)

- CoordinatorLoopManager 正确管理控制循环
- 基础设施层 sleep 可靠执行（可中断）
- 单任务失败不影响后续任务
- 连续失败 ≥ 5 次自动暂停循环
- 用户可通过 stats/cancel 监控和控制
- 测试覆盖启动、监控、暂停、恢复、停止

---

## 相关文档

- [FUSION_PROGRESS.md](../../FUSION_PROGRESS.md) - 融合进度主文档
- [fork-cache-optimization.ts](../../src/agents/fork-cache-optimization.ts) - 原始 Fork Cache 实现
- [coordinator.ts](../../src/agents/coordinator.ts) - 原始 Coordinator 实现
- [streaming-tool-executor.ts](../../src/agents/streaming-tool-executor.ts) - 原始 Streaming 执行器
- [background-task-tool.ts](../../src/agents/tools/background-task-tool.ts) - 现有后台任务工具

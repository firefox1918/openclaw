# 融合项目复盘决策：放弃影子实现

> **决策时间**: 2026-04-27
> **决策性质**: 技术决策 - 放弃架构不兼容的外围适配
> **影响范围**: Phase 10-12 + Phase 14-adapt

---

## 一、决策背景

### 1.1 融合项目初衷

融合项目的核心目标是：

> 将 Claude Code 以及 Hermes Agent 的优秀设计和方法论应用于 OpenClaw，并强化它。

**不是**：

- 照搬所有功能
- 强行嫁接架构不兼容的能力
- 创建"影子实现"来模拟表面功能

### 1.2 架构差异认知

在执行 Phase 10-14 时，发现 Claude Code 与 OpenClaw 存在根本架构差异：

| 维度               | Claude Code         | OpenClaw              | 冲突程度 |
| ------------------ | ------------------- | --------------------- | -------- |
| **工具执行**       | 自己实现 Tool.ts    | SessionManager 库     | 🔴 高    |
| **Agent 生命周期** | 长期运行 + 空闲循环 | 单次运行 → 返回       | 🔴 高    |
| **子Agent模式**    | Fork（继承上下文）  | Spawn（独立 session） | 🟡 中    |
| **持久化**         | 内置持久工作        | Gateway 管理          | 🔴 高    |

### 1.3 外围适配策略的代价

Phase 14-adapt 采用"外围适配"策略：

> 不修改 OpenClaw 核心代码（run.ts、SessionManager），通过外围层实现相同能力。

**代价**：

1. **影子实现** - 外围适配不是真正的 Claude Code 能力
2. **维护成本** - 两套系统并存，未来升级可能失效
3. **真实收益存疑** - 无法获得 Claude Code 的核心价值
4. **增加复杂度** - 没有增加真实能力，只增加了代码量

---

## 二、放弃的功能模块

### 2.1 Phase 10: StreamingToolExecutor

**原设计**：

```typescript
// Claude Code: 流式接收时立即执行，最大化并发
class StreamingToolExecutor {
  addTool(block) {
    void this.processQueue(); // 立即尝试执行
  }
}
```

**外围适配**：

```typescript
// OpenClaw: concurrency-control-wrapper.ts - 槽位管理
// SessionManager 库控制实际执行，外围只能做槽位限制
```

**放弃原因**：

- SessionManager 库内部已有并发控制
- 外围槽位管理是重复逻辑，无额外价值
- 无法实现真正的"流式接收时立即执行"

### 2.2 Phase 11: Fork Cache Optimization

**原设计**：

```typescript
// Claude Code: 批量 Fork 使用统一占位符，共享 Prompt Cache 前缀
const FORK_PLACEHOLDER_RESULT = "Fork started — processing in background";
```

**外围适配**：

```typescript
// OpenClaw: sessions-spawn-batch-tool.ts - 批量 spawn
// OpenClaw 使用 session-based spawn，不是 Fork
```

**放弃原因**：

- OpenClaw spawn 场景不常见批量需求
- Prompt Cache 共享的前提是"大量相似请求"，OpenClaw 无此场景
- session-based spawn 与 Fork 是不同模式，强行适配无意义

### 2.3 Phase 12: Coordinator 空闲循环

**原设计**：

```typescript
// Claude Code: Agent 空闲时自动认领任务
while (true) {
  const task = await findAvailableTask();
  if (task) await claimAndExecute(task);
  else await sleep(5000);
}
```

**外围适配**：

```typescript
// OpenClaw: coordinator-loop-manager.ts - JavaScript 定时器轮询
// 这是外部脚本，不是 Agent 内部行为
```

**放弃原因**：

- OpenClaw 运行完成即返回，无"空闲状态"
- 外部定时器轮询 ≠ Agent 内部空闲循环
- 这不是 Coordinator，只是"外部定时任务"
- 如果真需要持久工作，应修改核心或接受架构差异

### 2.4 Phase 14-adapt: 适配版重新设计

**包含模块**：

- `concurrency-control-wrapper.ts` (Phase 10 适配)
- `sessions-spawn-batch-tool.ts` (Phase 11 适配)
- `coordinator-loop-manager.ts` (Phase 12 适配)
- `background-task-tool.ts` coordinator 模式扩展

**放弃原因**：

- 所有模块都是"影子实现"
- 增加复杂度，无真实收益

---

## 三、保留的功能模块

### 3.1 真正有价值的能力

| Phase   | 模块                 | 价值判断   | 保留原因                 |
| ------- | -------------------- | ---------- | ------------------------ |
| Phase 1 | memory 模块          | ⭐⭐⭐⭐   | 结构化记忆，架构兼容     |
| Phase 2 | compaction 模块      | ⭐⭐⭐⭐⭐ | 熔断器是通用模式，无冲突 |
| Phase 3 | terminal 模块        | ⭐⭐⭐⭐⭐ | 危险检测解决真实安全问题 |
| Phase 6 | permissions 模块     | ⭐⭐⭐⭐⭐ | 运行时权限决策，核心安全 |
| Phase 8 | skill-manage-tool.ts | ⭐⭐⭐⭐   | Agent 学习能力，核心价值 |
| Phase 9 | persistence.ts       | ⭐⭐⭐⭐   | 用户偏好持久化，体验提升 |

### 3.2 价值验证

这些保留模块：

- ✅ 解决 OpenClaw 真实问题
- ✅ 与 OpenClaw 架构兼容
- ✅ 不需要修改核心代码
- ✅ 测试覆盖完整（167 tests）

---

## 四、清理任务规划

### 4.1 代码清理任务

| 任务                | 目标文件                                        | 操作     | 风险       |
| ------------------- | ----------------------------------------------- | -------- | ---------- |
| 删除 Phase 10 模块  | `src/agents/streaming-tool-executor.ts`         | 删除     | 低         |
| 删除 Phase 10 适配  | `src/agents/concurrency-control-wrapper.ts`     | 删除     | 低         |
| 删除 Phase 10 测试  | `src/agents/streaming-tool-executor.test.ts`    | 删除     | 低         |
| 删除 Phase 11 模块  | `src/agents/fork-cache-optimization.ts`         | 删除     | 低         |
| 删除 Phase 11 适配  | `src/agents/tools/sessions-spawn-batch-tool.ts` | 删除     | 需检查注册 |
| 删除 Phase 11 测试  | 相关测试文件                                    | 删除     | 低         |
| 删除 Phase 12 模块  | `src/agents/coordinator.ts`                     | 删除     | 低         |
| 删除 Phase 12 适配  | `src/agents/coordinator-loop-manager.ts`        | 删除     | 低         |
| 删除 Phase 12 测试  | 相关测试文件                                    | 删除     | 低         |
| 清理 Phase 14-adapt | 4个文件 + 测试                                  | 删除     | 需检查依赖 |
| 清理工具注册        | `openclaw-tools.ts`                             | 移除注册 | 需检查引用 |

### 4.2 文档更新任务

| 任务         | 目标文件                         | 操作                   |
| ------------ | -------------------------------- | ---------------------- |
| 更新主文档   | `docs/FUSION_SUMMARY.md`         | 添加链接，标记放弃     |
| 更新进度文档 | `FUSION_PROGRESS.md`             | 标记放弃，保留决策记录 |
| 创建决策文档 | `docs/FUSION_DECISION_RECORD.md` | 本文档                 |

### 4.3 验证任务

| 任务            | 命令                       | 目标                 |
| --------------- | -------------------------- | -------------------- |
| TypeScript 编译 | `pnpm tsgo`                | 确保无编译错误       |
| 测试通过        | `pnpm test`                | 确保保留模块测试正常 |
| Lint 检查       | `pnpm lint`                | 确保无 lint 错误     |
| Import cycles   | `pnpm check:import-cycles` | 确保无循环依赖       |

---

## 五、后续聚焦方向

### 5.1 待优化方向（有价值）

按 FUSION_SUMMARY.md 第五章，有价值的优化：

| 方向                           | 优先级 | 价值                             |
| ------------------------------ | ------ | -------------------------------- |
| Coordinator 自动触发           | 中     | 需重新评估是否真的需要           |
| Prompt Cache 稳定性            | 中     | OpenClaw 已有原生实现（Phase 7） |
| 技能学习触发自动化             | 低     | 需核心改动，暂缓                 |
| 权限配置 UI                    | 低     | Control UI 增强                  |
| modal/daytona/singularity 后端 | 低     | 扩展 sandbox                     |

### 5.2 真正值得投入的方向

基于本次决策，建议聚焦：

**短期**：

1. 权限配置 UI - 让用户更方便管理权限
2. 完善现有保留模块的文档和测试

**中期**：

1. 技能学习触发自动化 - 如果决定修改核心
2. modal/daytona/singularity 后端扩展

**长期**：

1. 如果确实需要持久工作能力，考虑修改 OpenClaw 核心架构
2. 或者接受 OpenClaw 的"单次运行"定位，不强求

---

## 六、决策结论

**放弃**：Phase 10-12 + Phase 14-adapt 的外围适配（影子实现）

**保留**：Phase 1, 2, 3, 6, 8, 9（真正有价值且架构兼容）

**核心理念**：

> 将优秀的设计和方法论应用于 OpenClaw，强化它。
> 不强行嫁接架构不兼容的能力，不创建影子实现。

---

## 附录：执行日志

### 清理执行记录 (2026-04-27)

**删除文件清单**（16 个文件）：

| 文件                                                 | 操作 | 状态 |
| ---------------------------------------------------- | ---- | ---- |
| `src/agents/streaming-tool-executor.ts`              | 删除 | ✅   |
| `src/agents/streaming-tool-executor.test.ts`         | 删除 | ✅   |
| `src/agents/concurrency-control-wrapper.ts`          | 删除 | ✅   |
| `src/agents/concurrency-control-wrapper.test.ts`     | 删除 | ✅   |
| `src/agents/fork-cache-optimization.ts`              | 删除 | ✅   |
| `src/agents/fork-cache-optimization.test.ts`         | 删除 | ✅   |
| `src/agents/coordinator.ts`                          | 删除 | ✅   |
| `src/agents/coordinator.test.ts`                     | 删除 | ✅   |
| `src/agents/coordinator-loop-manager.ts`             | 删除 | ✅   |
| `src/agents/coordinator-loop-manager.test.ts`        | 删除 | ✅   |
| `src/agents/background-tasks.ts`                     | 删除 | ✅   |
| `src/agents/background-tasks.test.ts`                | 删除 | ✅   |
| `src/agents/tools/sessions-spawn-batch-tool.ts`      | 删除 | ✅   |
| `src/agents/tools/sessions-spawn-batch-tool.test.ts` | 删除 | ✅   |
| `src/agents/tools/background-task-tool.ts`           | 删除 | ✅   |
| `src/agents/tools/background-task-tool.test.ts`      | 删除 | ✅   |

**注册清理**：

| 文件                           | 操作                                    | 状态 |
| ------------------------------ | --------------------------------------- | ---- |
| `src/agents/openclaw-tools.ts` | 移除 sessions-spawn-batch import + 注册 | ✅   |
| `src/agents/openclaw-tools.ts` | 移除 background-task-tool import + 注册 | ✅   |

**验证结果**：

| 验证项          | 命令        | 结果                 |
| --------------- | ----------- | -------------------- |
| TypeScript 编译 | `pnpm tsgo` | ✅ 通过              |
| 测试            | `pnpm test` | ✅ 2502 tests passed |

**保留模块验证**（确认无影响）：

| Phase   | 模块              | 测试状态 |
| ------- | ----------------- | -------- |
| Phase 1 | memory 模块       | ✅ 正常  |
| Phase 2 | compaction 模块   | ✅ 正常  |
| Phase 3 | terminal 模块     | ✅ 正常  |
| Phase 6 | permissions 模块  | ✅ 正常  |
| Phase 8 | skill-manage-tool | ✅ 正常  |
| Phase 9 | persistence       | ✅ 正常  |

**结论**：清理完成，保留模块无任何影响，项目更精简。

# OpenClaw 融合实施方案 - 执行进度跟踪

> **创建时间**: 2026-04-13
> **最后更新**: 2026-04-16
> **目标**: 将 Claude Code 的工程化设计思路和 Hermes Agent 的能力扩展，嫁接到 OpenClaw 项目中

---

## 执行优先级顺序

按照依赖关系，执行顺序为：

```
Phase 6 (权限系统) → Phase 2 (上下文管理) → Phase 1 (记忆系统) → Phase 3 (终端执行) → Phase 4 (技能系统) → Phase 5 (任务/Fork)
```

---

## Phase 6: 权限系统增强 [最高优先级]

**状态**: ✅ 已完成
**完成时间**: 2026-04-14
**实际工作量**: 1天
**文件数量**: 7个文件

### 文件清单

| 文件路径                                     | 操作 | 状态                        |
| -------------------------------------------- | ---- | --------------------------- |
| `src/agents/permissions/types.ts`            | 新建 | ✅ 已完成                   |
| `src/agents/permissions/pipeline.ts`         | 新建 | ✅ 已完成                   |
| `src/agents/permissions/rules.ts`            | 新建 | ✅ 已完成                   |
| `src/agents/permissions/modes.ts`            | 新建 | ✅ 已完成                   |
| `src/agents/permissions/index.ts`            | 新建 | ✅ 已完成                   |
| `src/agents/permissions/index.test.ts`       | 新建 | ✅ 已完成 (28 tests passed) |
| `src/agents/permissions/INTEGRATION_PLAN.md` | 新建 | ✅ 已完成                   |

---

## Phase 2: 上下文管理工程化 [高优先级]

**状态**: ⏳ 待开始
**预计工作量**: 2周
**文件数量**: 5个文件

---

## Phase 1: 记忆系统工程化 [中优先级]

**状态**: ⏳ 待开始
**预计工作量**: 2-3周
**文件数量**: 5个文件

---

## Phase 3: 终端执行能力 [中优先级]

**状态**: ✅ 已完成
**完成时间**: 2026-04-15 ~ 2026-04-16
**实际工作量**: 2天
**文件数量**: 7个文件

### 文件清单

| 文件路径                                                   | 操作 | 状态                        |
| ---------------------------------------------------------- | ---- | --------------------------- |
| `src/agents/terminal/types.ts`                             | 新建 | ✅ 已完成                   |
| `src/agents/terminal/dangerous.ts`                         | 新建 | ✅ 已完成                   |
| `src/agents/terminal/backend-manager.ts`                   | 新建 | ✅ 已完成                   |
| `src/agents/terminal/local.ts`                             | 新建 | ✅ 已完成                   |
| `src/agents/terminal/index.ts`                             | 新建 | ✅ 已完成                   |
| `src/agents/terminal/index.test.ts`                        | 新建 | ✅ 已完成 (41 tests passed) |
| `src/agents/bash-tools.exec-dangerous-check.ts`            | 新建 | ✅ 已完成                   |
| `src/agents/bash-tools.exec-dangerous-check.test.ts`       | 新建 | ✅ 已完成 (17 tests passed) |
| `src/agents/bash-tools.exec-dangerous.integration.test.ts` | 新建 | ✅ 已完成 (21 tests passed) |
| `src/agents/bash-tools.exec.ts`                            | 修改 | ✅ 已完成 (危险检测集成)    |
| `scripts/verify-dangerous-command-detection.sh`            | 新建 | ✅ 已完成                   |

### 实现内容

#### Phase 3-A: Terminal 模块核心实现 (Apr 15)

1. **危险命令检测** (`dangerous.ts`):
   - 30+ 危险命令模式检测
   - 命令规范化处理（ANSI、Unicode、Null byte）
   - 会话级审批缓存
   - 权限系统集成接口

2. **Backend 管理器** (`backend-manager.ts`):
   - 多后端支持框架（local/docker/ssh/modal/daytona）
   - 后端注册与切换
   - 快速执行封装

3. **类型定义** (`types.ts`):
   - `DangerousPattern`: 危险命令模式定义
   - `DangerousDetectionResult`: 检测结果类型
   - `TerminalExecuteResult`: 执行结果类型
   - `TerminalBackendConfig`: 后端配置类型

#### Phase 3-B: bash-tools.exec 桥接集成 (Apr 16)

1. **危险检测桥接** (`bash-tools.exec-dangerous-check.ts`):
   - `checkDangerousCommandAndRequestApproval`: 核心审批流程
   - Gateway 审批集成（`plugin.approval.request/waitDecision`）
   - Headless/cron 模式自动拒绝
   - 会话级审批缓存（`allow-always` 决策）

2. **exec 工具集成** (`bash-tools.exec.ts:1508-1527`):
   - 在 `rejectExecApprovalShellCommand` 后插入危险检测
   - 检测结果处理：block → throw error
   - 审批通过：warnings 推送审批信息

### 执行流程

```
bash-tools.exec.ts execute()
│
├─ Line 1508: rejectExecApprovalShellCommand()
│
├─ ★ Line 1511-1527: checkDangerousCommandAndRequestApproval()
│   ├─ checkDangerousCommandPermission() → 检测 30+ 模式
│   ├─ behavior="allow" → 继续
│   ├─ behavior="deny" → throw error
│   ├─ trigger="cron" → 自动拒绝（headless）
│   └─ behavior="ask" → Gateway 审批流程
│       ├─ plugin.approval.request → 创建审批
│       ├─ plugin.approval.waitDecision → 等待决策
│       ├─ "allow-always" → approvePatternForSession()
│       └─ "deny"/timeout → throw error
│
├─ Line 1529+: 现有流程继续
```

### 测试覆盖

| 测试文件                                        | 测试数 | 状态    |
| ----------------------------------------------- | ------ | ------- |
| `terminal/index.test.ts`                        | 41     | ✅ 通过 |
| `bash-tools.exec-dangerous-check.test.ts`       | 17     | ✅ 通过 |
| `bash-tools.exec-dangerous.integration.test.ts` | 21     | ✅ 通过 |
| **总计**                                        | **79** | ✅ 通过 |

---

## Phase 4: 技能系统 [中优先级]

**状态**: ⏳ 待开始
**预计工作量**: 2周
**文件数量**: 6个文件

---

## Phase 5: 任务/Fork [低优先级]

**状态**: ⏳ 待开始
**预计工作量**: 1-2周
**文件数量**: 4个文件

---

## 整体进度

| Phase   | 状态      | 完成时间   |
| ------- | --------- | ---------- |
| Phase 6 | ✅ 已完成 | 2026-04-14 |
| Phase 2 | ⏳ 待开始 | -          |
| Phase 1 | ⏳ 待开始 | -          |
| Phase 3 | ✅ 已完成 | 2026-04-16 |
| Phase 4 | ⏳ 待开始 | -          |
| Phase 5 | ⏳ 待开始 | -          |

**总进度**: 2/6 (33%)

---

## 注意事项

- Phase 3 虽然跳过了 Phase 2 和 Phase 1，但 terminal 模块的核心实现不依赖于它们
- 按依赖顺序，下一步应该是 Phase 2（上下文管理）
- 手动功能验证因项目预先存在的构建问题（`INEFFECTIVE_DYNAMIC_IMPORT`）暂时无法进行

# OpenClaw 融合实施方案 - 全面梳理报告

> **分析时间**: 2026-04-16
> **验证时间**: 2026-04-16
> **核心理念**: 强化OpenClaw的自主持久工作能力和自主技能形成能力
>
> **Claude Code贡献**: 自主持久工作能力 - 12层Harness机制让Agent能长时间稳定完成复杂编程任务
>
> **Hermes Agent贡献**: 自主技能形成能力 - Agent从有效流程中学习并固化可复用技能

---

## 0. 验证状态 (2026-04-16)

**测试验证完成**:

- Phase 1 记忆系统: 43 tests passed ✅
- Phase 2 熔断器/递归保护: 35 tests passed ✅
- Phase 3 危险命令检测: 41 tests passed ✅
- Phase 6 权限系统: 28 tests passed ✅

**运行时集成验证**:

- Phase 1: `run.ts:42,429` - initializeMemoryRuntime ✅
- Phase 2: `run.ts:31,425,854-1130` - CircuitBreaker + runInCompactionContext ✅
- Phase 3: `bash-tools.exec.ts:23,1511-1526` - checkDangerousCommandAndRequestApproval ✅
- Phase 6: `pi-tools.ts:51,673-691`, `pi-tools.before-tool-call.ts:12,148,252` ✅

---

## 1. 融合目标

**Claude Code的核心价值**（自主持久工作）：

- 12层渐进式Harness机制
- StreamingToolExecutor流式并发执行
- Fork子Agent缓存优化
- Coordinator模式（自主认领任务）
- Background Tasks后台持久执行
- 熔断器+递归保护（稳定运行）

**Hermes Agent的核心价值**（学习能力）：

- skill_manage工具（自主技能管理）
- 学习触发检测（何时应该记录）
- 工作流程提取（如何固化知识）
- Agent越用越聪明，避免重复探索

---

## 2. 原始缺失能力（已覆盖部分）

### Claude Code能力（自主持久工作）

| #   | 能力                      | 实现方案                                | 代码证据                      | 完整度  |
| --- | ------------------------- | --------------------------------------- | ----------------------------- | ------- |
| 1   | **运行时权限决策**        | Phase 6.2: runPermissionCheck()         | before-tool-call.ts:148-189   | ✅ 100% |
| 2   | **checkPermissions方法**  | Phase 6.1: checkRuntimePermission()     | permissions/index.ts          | ✅ 100% |
| 3   | **危险命令检测**          | Phase 3: DANGEROUS_PATTERNS + 桥接      | terminal/dangerous.ts         | ✅ 100% |
| 4   | **权限上下文传递**        | Phase 6.2: HookContext.permissionConfig | pi-tools.ts:689               | ✅ 100% |
| 5   | **模式切换**              | Phase 6.1: PermissionMode类型 + 配置    | types.agent-defaults.ts       | ✅ 100% |
| 6   | **极致缓存利用**          | OpenClaw原生已实现                      | prompt-cache-observability.ts | ✅ 100% |
| 7   | **熔断器保护**            | Phase 2: CircuitBreaker                 | compaction/circuit-breaker.ts | ✅ 100% |
| 8   | **递归保护**              | Phase 2: RecursionGuard                 | compaction/recursion-guard.ts | ✅ 100% |
| 9   | **StreamingToolExecutor** | ⏳ 待实现                               | -                             | ❌ 0%   |
| 10  | **Fork子Agent优化**       | ⏳ 待实现                               | -                             | ❌ 0%   |
| 11  | **Coordinator模式**       | ⏳ 待实现                               | -                             | ❌ 0%   |
| 12  | **Background Tasks**      | ⏳ 待实现                               | -                             | ❌ 0%   |

### Hermes Agent能力（学习）

| #   | 能力             | 实现方案                         | 代码证据  | 完整度 |
| --- | ---------------- | -------------------------------- | --------- | ------ |
| 13  | **自主技能形成** | Phase 8: skill_manage + 学习触发 | ⏳ 待实现 | ❌ 0%  |
| 14  | **规则持久化**   | Phase 9: persistence.ts          | ⏳ 待实现 | ❌ 0%  |

---

## 2. 各Phase实现状态详细分析

### Phase 6: 权限系统 (100% ✅)

#### Phase 6.1 权限模块实现

| 组件     | 文件                      | 功能                          | 验证状态    |
| -------- | ------------------------- | ----------------------------- | ----------- |
| 类型定义 | `permissions/types.ts`    | PermissionMode, Rule, Context | ✅ 28 tests |
| 模式系统 | `permissions/modes.ts`    | 5种模式判断 + 行为决策        | ✅ 28 tests |
| 规则匹配 | `permissions/rules.ts`    | wildcard/prefix/group匹配     | ✅ 28 tests |
| 管道执行 | `permissions/pipeline.ts` | 6阶段管道 + 短路机制          | ✅ 28 tests |

#### Phase 6.2 权限融入

| 集成点                       | 代码位置                            | 功能                    | 验证状态             |
| ---------------------------- | ----------------------------------- | ----------------------- | -------------------- |
| 配置转换                     | `runtime-permission-check.ts:36-80` | policiesToRulesBySource | ✅ 编译通过          |
| pi-tools.ts                  | `pi-tools.ts:672-689`               | buildPermissionConfig   | ✅ 传递到HookContext |
| pi-tools.before-tool-call.ts | `before-tool-call.ts:148-189`       | runPermissionCheck      | ✅ 运行时调用        |
| Gateway审批                  | `before-tool-call.ts:266-370`       | ask行为触发审批         | ✅ 完整流程          |

**结论**: Phase 6 完整实现运行时权限决策能力。

---

### Phase 2: 上下文管理工程化 (100% ✅)

#### 核心模块实现

| 组件     | 文件                              | 功能                      | 验证状态    |
| -------- | --------------------------------- | ------------------------- | ----------- |
| 熔断器   | `compaction/circuit-breaker.ts`   | closed/open/half-open三态 | ✅ 35 tests |
| 阈值管理 | `compaction/threshold-manager.ts` | Token预算计算             | ✅ 35 tests |
| 递归保护 | `compaction/recursion-guard.ts`   | AsyncLocalStorage追踪     | ✅ 35 tests |

#### run.ts集成

| 集成点       | 代码位置            | 功能                           | 验证状态 |
| ------------ | ------------------- | ------------------------------ | -------- |
| 熔断器创建   | `run.ts:425`        | createCompactionCircuitBreaker | ✅       |
| Timeout检查  | `run.ts:~851`       | circuitBreaker.isAllowed()     | ✅       |
| Overflow检查 | `run.ts:~1000`      | circuitBreaker.isAllowed()     | ✅       |
| 成功记录     | `run.ts:~897,~1060` | recordSuccess()                | ✅       |
| 失败记录     | `run.ts:~906,~1086` | recordFailure()                | ✅       |
| 递归追踪     | `run.ts:~896,~1050` | runInCompactionContext         | ✅       |

**结论**: Phase 2 完整实现熔断保护，防止压缩死循环。

---

### Phase 1: 记忆系统工程化 (100% ✅)

#### 核心模块实现

| 组件     | 文件                          | 功能                      | 验证状态    |
| -------- | ----------------------------- | ------------------------- | ----------- |
| 类型定义 | `memory/memory-types.ts`      | MEMORY_TYPES强制分类      | ✅ 43 tests |
| 索引管理 | `memory/memory-index.ts`      | 解析/格式化/读写MEMORY.md | ✅ 43 tests |
| 管理器   | `memory/memory-manager.ts`    | 三层scope CRUD            | ✅ 43 tests |
| 截断工具 | `memory/memory-truncation.ts` | 优先级截断+归档           | ✅ 43 tests |

#### 运行时集成

| 集成点            | 代码位置                  | 功能                           | 验证状态    |
| ----------------- | ------------------------- | ------------------------------ | ----------- |
| 桥接模块          | `memory-runtime.ts`       | initializeMemoryRuntime        | ✅ 新建     |
| prompt supplement | `memory-runtime.ts:90`    | registerMemoryPromptSupplement | ✅          |
| 启动初始化        | `run.ts:428-437`          | initializeMemoryRuntime        | ✅          |
| 系统提示注入      | `memory-state.ts:206-219` | buildMemoryPromptSection       | ✅ 已有机制 |

**结论**: Phase 1 实现记忆系统，注入系统提示。

---

### Phase 3: 终端执行能力 (100% ✅)

#### 核心模块实现

| 组件     | 文件                          | 功能                   | 验证状态    |
| -------- | ----------------------------- | ---------------------- | ----------- |
| 类型定义 | `terminal/types.ts`           | DANGEROUS_PATTERNS 30+ | ✅ 41 tests |
| 危险检测 | `terminal/dangerous.ts`       | detectDangerousCommand | ✅ 41 tests |
| 本地后端 | `terminal/local.ts`           | executeLocalCommand    | ✅ 41 tests |
| 后端管理 | `terminal/backend-manager.ts` | 统一执行接口           | ✅ 41 tests |

#### bash-tools.exec桥接

| 集成点           | 代码位置                             | 功能                                    | 验证状态    |
| ---------------- | ------------------------------------ | --------------------------------------- | ----------- |
| 审批流程         | `bash-tools.exec-dangerous-check.ts` | checkDangerousCommandAndRequestApproval | ✅ 17 tests |
| Gateway审批      | `dangerous-check.ts:90-130`          | plugin.approval.request/wait            | ✅          |
| exec集成         | `bash-tools.exec.ts:~1508-1527`      | 插入检测逻辑                            | ✅ 21 tests |
| headless自动拒绝 | `dangerous-check.ts:75-80`           | trigger="cron"                          | ✅          |

**结论**: Phase 3 完整实现危险命令检测+审批流程。

---

## 3. 总结

### Claude Code能力实现状态（自主持久工作）

**已实现 (8/12)**:

- ✅ 运行时权限决策 (allow/ask/deny)
- ✅ checkPermissions 管道
- ✅ 危险命令检测 (30+模式)
- ✅ 权限上下文传递
- ✅ 模式切换 (5种模式)
- ✅ **极致缓存利用** (OpenClaw原生)
- ✅ **熔断器保护** (Phase 2)
- ✅ **递归保护** (Phase 2)

**待实现 (4/12)**:

- ❌ StreamingToolExecutor流式并发
- ❌ Fork子Agent缓存优化
- ❌ Coordinator模式（自主认领）
- ❌ Background Tasks后台持久

### Hermes Agent能力实现状态（学习）

**已实现 (0/2)**:

- ❌ 自主技能形成 (Phase 8)
- ❌ 规则持久化 (Phase 9)

### 整体进度

**Claude Code自主持久**: 8/12 完成 (67%)
**Hermes学习能力**: 0/2 完成 (0%)

---

## 4. 建议下一步

### 优先级排序

1. **实现自主技能形成 (Phase 8)** - Hermes Agent学习能力，让Agent"进化"
2. **增强自主持久工作** - 补充StreamingToolExecutor、Fork、Coordinator、Background Tasks
3. **实现规则持久化 (Phase 9)** - 记忆用户偏好
4. **Phase 4/5** - 技能扩展、多Agent协作（非核心）

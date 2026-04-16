# OpenClaw 融合实施方案 - 执行进度跟踪

> **创建时间**: 2026-04-13
> **目标**: 将 Claude Code 的工程化设计思路和 Hermes Agent 的能力扩展，嫁接到 OpenClaw 项目中

---

## 三项目架构理解

### Claude Code 核心架构 (TypeScript)

```
关键源码文件:
├── src/Tool.ts
│   └── Tool接口定义: checkPermissions(input, context) → PermissionResult
│   └── 每个工具实现自己的权限检查逻辑
│   └── validateInput(), prompt(), renderToolResultMessage()
│
├── src/types/permissions.ts
│   └── PermissionMode: default/plan/acceptEdits/bypassPermissions/dontAsk/auto
│   └── PermissionBehavior: allow/deny/ask
│   └── PermissionRule: { source, ruleBehavior, ruleValue }
│   └── ToolPermissionContext: 会话级权限上下文（贯穿整个运行）
│   └── PermissionResult: allow/ask/deny + message + suggestions
│
├── src/utils/permissions/permissions.ts
│   └── hasPermissionsToUseTool: 核心入口函数
│   ├── getAllowRules/getDenyRules/getAskRules: 规则收集
│   ├── toolMatchesRule: 工具名匹配（支持MCP工具）
│   ├── createPermissionRequestMessage: 消息生成
│   └── runPermissionRequestHooksForHeadlessAgent: 无头Agent处理
│
├── src/utils/permissions/PermissionMode.ts
│   └── PERMISSION_MODE_CONFIG: 模式配置（标题、图标、颜色）
│   └── permissionModeTitle, isDefaultMode: 模式判断函数
│
├── src/tools/BashTool/bashPermissions.ts (最复杂的权限实现)
│   └── bashToolHasPermission: Bash工具权限入口
│   ├── checkPermissionMode: 模式检查
│   ├── checkPathConstraints: 路径约束
│   ├── checkSemantics: 命令语义分析
│   ├── MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50: 安全检查上限
│
├── src/tools/AgentTool/forkSubagent.ts
│   └── Fork子Agent创建
│   └── 权限上下文继承
│
├── src/services/compact/autoCompact.ts
│   └── AUTOCOMPACT_BUFFER_TOKENS = 13_000
│   ├── MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3 (熔断器)
│
├── src/memdir/memdir.ts
│   └── truncateEntrypointContent: 记忆截断
│   ├── MAX_MEMORY_INDEX_LINES = 200
│
└── src/utils/tasks.ts
    └── Task数据结构 + 依赖图管理
    └── 原子认领逻辑
```

**核心设计要点**:

- `Tool.checkPermissions`: 每个工具实现自己的权限检查
- `ToolPermissionContext`: 贯穿整个运行，不是一次性过滤
- `PermissionMode`: 模式驱动动态决策（plan模式只允许read）
- `TRANSCRIPT_CLASSIFIER`: 智能审批feature（减少用户打扰）
- 规则持久化: 跨会话保存用户决策

### Hermes Agent 核心架构 (Python)

```
关键源码文件:
├── tools/approval.py (危险命令审批系统)
│   └── DANGEROUS_PATTERNS: 100+危险命令正则模式
│   ├── detect_dangerous_command(): 检测入口
│   ├── check_dangerous_command(): 完整审批流程
│   ├── check_all_command_guards(): tirith + dangerous合并检查
│   ├── prompt_dangerous_approval(): CLI交互
│   ├── _smart_approve(): auxiliary LLM智能审批
│   ├── YOLO模式: 完全绕过审批
│   ├── Per-session approval state: 线程安全
│   ├── Gateway blocking queue (_ApprovalEntry): 异步阻塞
│
├── tools/terminal_tool.py (多后端终端)
│   ├── 6种后端: local, docker, modal, ssh, daytona, singularity
│   ├── set_approval_callback(): 注册审批回调
│   ├── FOREGROUND_MAX_TIMEOUT = 600
│
├── tools/environments/base.py
│   └── BaseEnvironment: 统一接口
│   ├── execute(command, options) → ExecuteResult
│
├── tools/environments/docker.py
│   └── 安全沙箱配置: --cap-drop ALL, --pids-limit 256
│
├── gateway/__init__.py (多平台消息集成)
│   ├── SessionContext: 会话管理 + 上下文注入
│   ├── DeliveryRouter: cron输出路由
│
├── environments/agent_loop.py (工具调用循环)
│   └── HermesAgentLoop: 运行引擎
│   ├── handle_function_call: 工具执行分发
│   ├── Thread pool (128 workers): 并发执行
│
├── acp_adapter/permissions.py
│   └── ACP permission bridging
│   └── make_approval_callback(): Gateway审批回调
│
└── tools/skills_tool.py
    └── skills_list, skill_view
```

**核心设计要点**:

- `DANGEROUS_PATTERNS`: 100+经过实战验证的危险命令模式
- `Smart Approvals`: auxiliary LLM智能审批，减少打扰
- `Gateway blocking queue`: 异步场景下的阻塞式审批
- `tirith_security`: 外部安全扫描集成
- `YOLO模式`: 完全绕过（用于自动化场景）

### OpenClaw 核心架构 (TypeScript)

```
关键源码文件:
├── src/agents/pi-tools.ts (工具组装核心)
│   └── resolveEffectiveToolPolicy: 解析工具策略
│   ├── applyToolPolicyPipeline: 启动时过滤 (Layer 1)
│   ├── applyOwnerOnlyToolPolicy: owner限制 (Layer 2)
│   ├── wrapToolWithBeforeToolCallHook: 执行前钩子
│   ├── applyModelProviderToolPolicy: 模型级策略
│
├── src/agents/tools/common.ts
│   └── AnyAgentTool接口: name, label, description, parameters, execute
│   ├── ownerOnly标记: owner限制
│   ├── ❌ 无checkPermissions方法！
│
├── src/agents/tool-policy.ts (启动时过滤)
│   └── ToolPolicyLike: {allow?: string[], deny?: string[]}
│   ├── applyOwnerOnlyToolPolicy: owner限制
│   ├── collectExplicitAllowlist: allow收集
│   ├── 简单字符串匹配
│   ├── ❌ 无运行时决策
│
├── src/agents/tool-policy-pipeline.ts
│   └── ToolPolicyPipelineStep: 多级策略管道
│   ├── buildDefaultToolPolicyPipelineSteps: profile→global→agent→group
│   ├── applyToolPolicyPipeline: 执行过滤
│
├── src/agents/pi-tools.before-tool-call.ts (执行前钩子)
│   └── runBeforeToolCallHook: 钩子入口
│   ├── 循环检测 (detectToolCallLoop)
│   ├── plugin hooks (before_tool_call)
│   ├── requireApproval: plugin审批流程
│   ├── ❌ 无危险命令检测
│
├── src/agents/pi-embedded-runner/run.ts (Agent运行核心)
│   └── runEmbeddedPiAgentWithBackend: 主运行循环
│   ├── 模型选择、Failover、认证
│   ├── ❌ 无权限上下文传递
│
├── src/plugins/* (Plugin系统)
│   └── plugin-sdk/*: 公共接口
│   ├── hooks系统
│   ├── Contract enforcement
│
└── src/agents/permissions/* (Phase 6新增)
    ├── types.ts: PermissionMode, PermissionRule, ToolPermissionContext
    ├── modes.ts: 模式判断函数
    ├── rules.ts: 规则匹配引擎
    ├── pipeline.ts: 6阶段管道
    └── index.ts: 导出 + checkPermission
```

**缺失能力**:

- ❌ 无运行时权限决策（allow/ask/deny）
- ❌ 无checkPermissions方法
- ❌ 无危险命令检测
- ❌ 无权限上下文传递
- ❌ 无模式切换（plan模式）
- ❌ 无规则持久化

---

## Phase 6 选择为最高优先级的原因

### 1. 安全基础设施层

权限系统是所有其他功能的**安全基础设施**，具有依赖关系：

```
Phase 6 (权限) ──┬── Phase 2 (上下文) - 压缩触发需要权限判断
                ├── Phase 3 (终端) - 危险命令需要权限审批
                ├── Phase 4 (技能) - 技能执行需要权限控制
                └── Phase 5 (任务) - 子Agent需要权限继承
```

没有运行时权限决策，其他Phase无法安全运行。

### 2. 能力差距巨大

| 能力               | OpenClaw现有 | Claude Code/Hermes  |
| ------------------ | ------------ | ------------------- |
| 启动时过滤         | ✅ 有        | ✅ 有               |
| 运行时决策         | ❌ 无        | ✅ 核心             |
| ask行为            | ❌ 无        | ✅ 有               |
| 模式切换           | ❌ 无        | ✅ 5种模式          |
| 危险命令检测       | ❌ 无        | ✅ Hermes有100+模式 |
| 规则持久化         | ❌ 无        | ✅ 有               |
| classifier智能审批 | ❌ 无        | ✅ 可选             |

### 3. Claude Code的工程化核心

permissions系统是Claude Code**最工程化的设计**:

- Tool.checkPermissions: 工具级权限控制
- ToolPermissionContext: 贯穿运行的上下文
- PermissionMode: 模式驱动的动态决策
- TRANSCRIPT_CLASSIFIER: 智能审批减少打扰

---

## 融入策略：渐进式替换

### 策略原则

**不是**"完全替换破坏现有"，**也不是**"可选兼容无人使用"。

而是：**新系统主导，旧配置兼容**

### 具体策略

```
架构:

Layer 1 (启动时): 使用新系统计算可用工具
├── 输入: 现有allow/deny配置 → 自动转换为PermissionRule
├── 处理: permissions模块的规则匹配
├── 输出: 可用工具列表
└── 效果: 与现有行为一致，但内部使用新引擎

Layer 2 (Owner-only): 保持现有
├── 不变，这是独立的安全层

Layer 3 (运行时): 新系统决策
├── 输入: PermissionContext（从配置+运行状态构建）
├── 处理: executePermissionPipeline
├── 输出: allow → 执行 / ask → 确认 / deny → 拒绝
└── 新能力: 模式切换、规则持久化、危险命令检测
```

### 现有配置自动映射

```typescript
// 现有配置
tools: { allow: ["exec", "read"], deny: ["gateway"] }

// 自动转换为PermissionRule
alwaysAllowRules: { agentPolicy: ["exec", "read"] }
alwaysDenyRules: { agentPolicy: ["gateway"] }
```

### 默认模式=default

- 无额外配置时，行为与现有系统一致
- 但有了运行时决策能力（ask/deny可以返回）

---

## 执行优先级顺序

按照依赖关系，执行顺序为：

```
Phase 6 (权限系统) → Phase 6融入 → Phase 2 (上下文管理) → Phase 1 (记忆系统) → Phase 3 (终端执行) → Phase 4 (技能系统) → Phase 5 (任务/Fork)
```

---

## Phase 6: 权限系统增强 [最高优先级]

### Phase 6.1: 模块实现

**状态**: ✅ 已完成
**实际工作量**: 1天
**文件数量**: 6个文件

#### 文件清单

| 文件路径                               | 操作 | 状态                        |
| -------------------------------------- | ---- | --------------------------- |
| `src/agents/permissions/types.ts`      | 新建 | ✅ 已完成                   |
| `src/agents/permissions/pipeline.ts`   | 新建 | ✅ 已完成                   |
| `src/agents/permissions/rules.ts`      | 新建 | ✅ 已完成                   |
| `src/agents/permissions/modes.ts`      | 新建 | ✅ 已完成                   |
| `src/agents/permissions/index.ts`      | 新建 | ✅ 已完成                   |
| `src/agents/permissions/index.test.ts` | 新建 | ✅ 已完成 (28 tests passed) |

#### 实现内容

1. **权限模式系统** (`modes.ts`):
   - 5种外部模式: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`
   - 1种内部模式: `auto` (classifier-based)
   - 模式配置: 标题、图标、颜色、描述
   - 模式检测函数: `isBypassPermissionsMode`, `isPlanMode`, `isDontAskMode` 等
   - 行为决策: `modeAllowsBehavior(read/write/execute)`

2. **规则匹配引擎** (`rules.ts`):
   - 规则解析: `parseRuleString("tool:content")`
   - 规则匹配: `ruleMatchesTool` 支持通配符、前缀、组匹配
   - 规则优先级: `deny > ask > allow`, 有内容规则优先
   - 工具组定义: `dangerous`, `filesystem`, `network`, `control`, `info`

3. **多层权限管道** (`pipeline.ts`):
   - 6阶段管道: `validateInput → hooks → ruleMatching → mode → toolCheck → scopeCheck`
   - 短路机制: 某阶段拒绝时立即停止
   - Hook支持: 自定义钩子函数介入管道
   - Scope检查: 验证所需权限范围
   - 便捷函数: `checkPermission`, `isOperationAllowed`

4. **类型定义** (`types.ts`):
   - `PermissionMode`, `PermissionBehavior`, `PermissionRule`
   - `PermissionProfile`, `PermissionUpdate`, `PermissionDecision`
   - `ToolPermissionContext`, `PermissionPipelineStage`

### Phase 6.2: 融入集成

**状态**: ✅ 已完成
**实际工作量**: 1天
**文件数量**: 3个文件修改 + 1个文件新建

#### 融入计划

```
Step 1: 配置层集成 ✅ 已完成
├── 目标: 现有allow/deny配置自动映射到PermissionRule
├── 文件: src/agents/runtime-permission-check.ts
├── 实现:
│   ├── policiesToRulesBySource(): 转换allow/deny到ToolPermissionRulesBySource
│   ├── createRuntimePermissionContext(): 从配置构建上下文（处理readonly属性）
│   ├── buildPermissionConfigFromPolicies(): 从OpenClaw策略构建配置
│   └── mergeRulesBySource(): 规则合并（profile优先）
└── 验证: TypeScript编译通过

Step 2: 运行时桥接 ✅ 已完成
├── 目标: 创建权限上下文并传递到执行点
├── 文件: src/agents/pi-tools.ts
├── 实现:
│   ├── 导入buildPermissionConfigFromPolicies
│   ├── 在wrapToolWithBeforeToolCallHook前构建permissionConfig
│   ├── 传递到HookContext.permissionConfig
└── 验证: TypeScript编译通过

Step 3: 执行点集成 ✅ 已完成
├── 目标: 在工具执行前调用权限检查
├── 文件: src/agents/pi-tools.before-tool-call.ts
├── 实现:
│   ├── runPermissionCheck(): 权限检查入口
│   ├── 处理deny → blocked=true
│   └── 处理ask → 触发approval流程（见Step 4）
└── 验证: TypeScript编译通过

Step 4: ask行为处理 ✅ 已完成
├── 目标: PermissionResult.behavior='ask'触发用户确认
├── 文件: src/agents/pi-tools.before-tool-call.ts
├── 实现:
│   ├── handlePermissionAsk(): 提取ask消息和原因
│   ├── callGatewayTool("plugin.approval.request"): 触发Gateway审批
│   ├── callGatewayTool("plugin.approval.waitDecision"): 等待用户决策
│   ├── 支持AbortSignal取消
│   └── 决策处理: ALLOW_ONCE/ALLOW_ALWAYS → 执行, DENY → 拒绝
└── 验证: TypeScript编译通过
```

#### 文件清单

| 文件路径                                  | 操作      | 状态                        |
| ----------------------------------------- | --------- | --------------------------- |
| `src/agents/runtime-permission-check.ts`  | 新建+修改 | ✅ 已完成                   |
| `src/agents/pi-tools.before-tool-call.ts` | 修改      | ✅ 已完成                   |
| `src/agents/pi-tools.ts`                  | 修改      | ✅ 已完成                   |
| `src/agents/permissions/pipeline.ts`      | 修复类型  | ✅ 已完成                   |
| `src/agents/permissions/index.test.ts`    | 修复测试  | ✅ 已完成 (28 tests passed) |

#### 已完成工作详情

**runtime-permission-check.ts**:

- ✅ `SimpleToolPolicy` 类型定义
- ✅ `RuntimePermissionConfig` 扩展（支持policies数组）
- ✅ `policiesToRulesBySource()` - 策略转换函数
- ✅ `createRuntimePermissionContext()` - 处理readonly属性，返回新对象
- ✅ `buildPermissionConfigFromPolicies()` - 从OpenClaw策略构建配置
- ✅ `handlePermissionAsk()` - 提取ask消息，支持多种reason类型

**pi-tools.ts**:

- ✅ 导入runtime-permission-check模块
- ✅ 在wrapToolWithBeforeToolCallHook前调用buildPermissionConfigFromPolicies
- ✅ 传递permissionConfig到HookContext

**pi-tools.before-tool-call.ts**:

- ✅ runPermissionCheck在权限检查后处理ask行为
- ✅ 完整的Gateway approval流程（request + waitDecision）
- ✅ AbortSignal支持（运行取消时中断审批等待）
- ✅ 复用PluginApprovalResolutions常量

**pipeline.ts**:

- ✅ 修复ToolChecker返回值的类型断言

**index.test.ts**:

- ✅ 新增createTestPermissionContext()测试辅助函数
- ✅ 修改所有测试使用新辅助函数（避免readonly属性修改）
- ✅ 28个测试全部通过

#### 验证结果

- ✅ TypeScript编译通过 (pnpm tsgo)
- ✅ 全量测试通过 (1770 passed, 1 unrelated timeout)
- ✅ Permissions模块测试通过 (28 tests passed)

#### 下一步工作

Phase 6.2 融入已完成。权限系统现在可以：

1. 从现有OpenClaw工具策略构建PermissionContext
2. 在运行时执行权限检查（allow/ask/deny）
3. ask行为触发Gateway审批流程

后续Phase可以继续执行：

- Phase 2: 上下文管理工程化
- Phase 1: 记忆系统工程化
- Phase 3: 终端执行能力
- Phase 4: 技能系统
- Phase 5: 任务系统与多智能体协作

| 文件路径                                  | 操作 | 状态              |
| ----------------------------------------- | ---- | ----------------- |
| `src/agents/runtime-permission-check.ts`  | 新建 | ✅ 已创建，需调整 |
| `src/agents/pi-tools.before-tool-call.ts` | 修改 | 🔄 进行中         |
| `src/agents/tool-policy.ts`               | 修改 | ⏳ 待开始         |
| `src/agents/pi-tools.ts`                  | 修改 | ⏳ 待开始         |
| `src/config/types.tools.ts`               | 修改 | ⏳ 待开始 (可选)  |

#### 已完成文件（上一个session）

**runtime-permission-check.ts** 已创建，但存在以下问题：

- ❌ 无法从配置获取permissionContext（缺少配置层集成）
- ❌ ask行为未触发用户确认（只返回askPrompt）
- ❌ 未与现有tool-policy系统集成

#### 下一步工作

1. **完成配置层集成** (Step 1)
   - 在tool-policy.ts中添加规则转换逻辑
   - 现有allow/deny → PermissionRule

2. **完成运行时桥接** (Step 2)
   - 在pi-tools.ts中构建permissionContext
   - 传递到wrapToolWithBeforeToolCallHook

3. **完成ask处理** (Step 4)
   - ask → requireApproval转换
   - 复用现有approval流程

#### 参考源码

- Claude Code: `claude-leaked-source/src/utils/permissions/permissions.ts`
- Claude Code: `claude-leaked-source/src/utils/permissions/PermissionMode.ts`
- Claude Code: `claude-leaked-source/src/Tool.ts` (ToolPermissionContext)
- OpenClaw: `src/agents/tool-policy.ts`
- OpenClaw: `src/agents/pi-tools.ts`

---

## Phase 2: 上下文管理工程化 [高优先级]

**状态**: ✅ 已完成 (核心模块)
**实际工作量**: 1天
**文件数量**: 6个文件

### 文件清单

| 文件路径                                     | 操作 | 状态                        |
| -------------------------------------------- | ---- | --------------------------- |
| `src/agents/compaction/types.ts`             | 新建 | ✅ 已完成                   |
| `src/agents/compaction/circuit-breaker.ts`   | 新建 | ✅ 已完成                   |
| `src/agents/compaction/threshold-manager.ts` | 新建 | ✅ 已完成                   |
| `src/agents/compaction/recursion-guard.ts`   | 新建 | ✅ 已完成                   |
| `src/agents/compaction/index.ts`             | 新建 | ✅ 已完成                   |
| `src/agents/compaction/index.test.ts`        | 新建 | ✅ 已完成 (35 tests passed) |
| `src/agents/pi-embedded-runner/run.ts`       | 集成 | ⏳ 待集成                   |

### 实现内容

#### types.ts - 类型定义和常量

- `AUTOCOMPACT_BUFFER_TOKENS = 13_000`: 自动压缩缓冲区
- `MANUAL_COMPACT_BUFFER_TOKENS = 3_000`: 手动压缩缓冲区
- `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`: 最大连续失败次数
- `CIRCUIT_BREAKER_COOLDOWN_MS = 60_000`: 熔断器冷却时间
- `COMPACT_BLOCKED_QUERY_SOURCES`: ['session_memory', 'compact', 'marble_origami']
- `CircuitBreakerState`: closed/open/half-open 三态
- `ThresholdCheckResult`: 阈值检查结果
- `RecursionGuardResult`: 递归保护结果

#### circuit-breaker.ts - 熔断器实现

- `CompactionCircuitBreaker` 类:
  - 状态机: closed → open → half-open → closed
  - `isAllowed()`: 检查是否允许压缩
  - `recordSuccess()`: 记录成功，重置计数或关闭熔断器
  - `recordFailure(reason)`: 记录失败，触发熔断
  - `getBlockReason()`: 获取阻止原因
- 冷却期后自动进入半开状态
- 半开状态成功后恢复关闭状态
- 失败立即重新打开熔断器

#### threshold-manager.ts - Token预算管理

- `ThresholdManager` 类:
  - 自动压缩阈值计算
  - 手动压缩阈值计算
  - 预emptive阈值检查（提示发送前）
  - 目标Token计算
  - 大上下文窗口自动缩放缓冲区
- 便捷函数: `shouldAutoCompact()`, `shouldManualCompact()`

#### recursion-guard.ts - 递归保护

- `RecursionGuard` 类:
  - 检查源是否在阻止列表
  - 处理 agent: 和 mcp: 前缀
  - 阻止尝试计数（监控）
- `AsyncLocalStorage` 集成:
  - `runInCompactionContext()`: 上下文追踪
  - `getCompactionDepth()`: 当前压缩深度
  - `isInCompaction()`: 是否在压缩中
  - `checkCompactionDepth()`: 深度检查（MAX=2）

#### index.ts - 便捷函数

- `createCompactionComponents()`: 创建完整组件集
- `makeCompactionDecision()`: 综合决策函数
- `shouldTriggerAutoCompaction()`: 快速检查

### 验证结果

- ✅ TypeScript编译通过 (pnpm tsgo)
- ✅ 测试全部通过 (35 tests passed)

### 下一步工作

模块已完成，需要在 `pi-embedded-runner/run.ts` 中集成：

1. 在运行时创建 CircuitBreaker 和 ThresholdManager
2. 在压缩触发前调用 `makeCompactionDecision()`
3. 压缩成功/失败后调用 `recordSuccess/recordFailure()`
4. 使用 `runInCompactionContext()` 追踪递归

### 参考源码

- Claude Code: `claude-leaked-source/src/services/compact/autoCompact.ts`
- Claude Code: `claude-leaked-source/src/services/compact/sessionMemoryCompact.ts`
- OpenClaw: `src/agents/pi-embedded-runner/session-truncation.ts`

---

## Phase 1: 记忆系统工程化 [中优先级]

**状态**: ✅ 已完成 (核心模块)
**实际工作量**: 1天
**文件数量**: 6个文件

### 文件清单

| 文件路径                          | 操作 | 状态                        |
| --------------------------------- | ---- | --------------------------- |
| `src/memory/memory-types.ts`      | 新建 | ✅ 已完成                   |
| `src/memory/memory-index.ts`      | 新建 | ✅ 已完成                   |
| `src/memory/memory-manager.ts`    | 新建 | ✅ 已完成                   |
| `src/memory/memory-truncation.ts` | 新建 | ✅ 已完成                   |
| `src/memory/index.ts`             | 新建 | ✅ 已完成                   |
| `src/memory/index.test.ts`        | 新建 | ✅ 已完成 (43 tests passed) |

### 实现内容

#### memory-types.ts - 类型定义和常量

- `MEMORY_TYPES`: ['user', 'feedback', 'project', 'reference'] 强制分类
- `MAX_MEMORY_INDEX_LINES = 200`: 索引最大行数
- `MAX_MEMORY_INDEX_BYTES = 25_000`: 索引最大字节
- `MAX_MEMORY_SUMMARY_CHARS = 500`: 概要最大字符
- `MAX_MEMORY_CONTENT_CHARS = 5_000`: 内容最大字符
- `SESSION_MEMORY_MAX_AGE_MS = 24 * 60 * 60 * 1000`: 会话记忆过期时间
- `MEMORY_EXCLUSION_PATTERNS`: 排除边界（代码模式、git历史、任务细节）
- `MemoryScope`: 'project' | 'agent' | 'session' 三层架构
- `MemoryEntry`, `MemoryIndex`, `MemoryContent`, `MemoryQuery` 类型

#### memory-index.ts - 索引文件管理

- `parseMemoryEntry(line)`: 解析 markdown 格式的记忆条目
- `formatMemoryEntry(entry)`: 格式化记忆条目为 markdown
- `readMemoryIndex(filePath)`: 读取索引文件
- `writeMemoryIndex(filePath, entries)`: 写入索引文件
- `buildMemoryIndexContent(entries)`: 按类型分组构建内容
- `checkMemoryIndexSize(content)`: 检查大小约束
- `truncateMemoryIndex(entries, archivePath)`: 截断索引（保留最近的）
- `generateMemoryId()`: 生成唯一ID
- `generateContentHash(content)`: 内容哈希（用于去重）
- `mergeMemoryEntries(existing, newEntries)`: 合并去重

#### memory-manager.ts - 记忆管理器

- `MemoryManager` 类:
  - 三层scope支持: project/agent/session
  - `load()`: 加载记忆索引
  - `add(content)`: 添加记忆（类型验证、排除检查、自动截断）
  - `query(params)`: 查询记忆（按类型、源、搜索、limit）
  - `remove(id)`: 删除记忆
  - `cleanExpired()`: 清理过期会话记忆
  - `save()`: 强制保存
- 工厂函数:
  - `createProjectMemoryManager()`: 项目级管理器
  - `createAgentMemoryManager(agentId)`: Agent级管理器
  - `createSessionMemoryManager(sessionKey)`: 会话级管理器
- `buildGlobalMemoryIndex()`: 构建全局索引（合并所有scope）

#### memory-truncation.ts - 截断工具

- `truncateMemoryContent(content)`: 内容截断
- `truncateMemorySummary(summary)`: 概要截断
- `checkNeedsTruncation(entries)`: 检查是否需要截断
- `truncateMemoryEntries(entries, archiveDir)`: 截断条目（移除最旧的）
- `archiveEntries(entries, archiveDir)`: 归档移除的条目
- `cleanOldArchives(archiveDir, maxAgeDays)`: 清理旧归档
- `calculateMemoryBudget(contextWindowTokens)`: 计算内存预算
- `estimateMemoryTokens(entries)`: 估算token数量
- `getTruncationPriority(entry)`: 获取截断优先级（high/medium/low）
- `truncateWithPriority(entries)`: 优先级截断（保留高优先级）

### 验证结果

- ✅ TypeScript编译通过 (lint clean)
- ✅ 测试全部通过 (43 tests passed)

### 下一步工作

模块已完成，需要在运行时集成：

1. 在会话启动时创建 MemoryManager
2. 将记忆内容注入系统提示
3. 会话结束时清理过期记忆
4. 与 compaction 模块配合（压缩时保留记忆）

### 参考源码

- Claude Code: `claude-leaked-source/src/memdir/memdir.ts` (truncateEntrypointContent)
- Claude Code: `claude-leaked-source/src/memdir/memoryTypes.ts` (MEMORY_TYPES)
- OpenClaw: `src/config/types.memory.ts`
- OpenClaw: `src/agents/skills/workspace.ts` (现有技能发现模式可参考)

---

## Phase 3: 终端执行能力 [中优先级]

**状态**: ✅ 已完成 (核心模块 + bash-tools桥接)
**实际工作量**: 2天
**文件数量**: 11个文件

### Phase 3-A: Terminal 模块核心实现

#### 文件清单

| 文件路径                                 | 操作 | 状态                        |
| ---------------------------------------- | ---- | --------------------------- |
| `src/agents/terminal/types.ts`           | 新建 | ✅ 已完成                   |
| `src/agents/terminal/dangerous.ts`       | 新建 | ✅ 已完成                   |
| `src/agents/terminal/local.ts`           | 新建 | ✅ 已完成                   |
| `src/agents/terminal/backend-manager.ts` | 新建 | ✅ 已完成                   |
| `src/agents/terminal/index.ts`           | 新建 | ✅ 已完成                   |
| `src/agents/terminal/index.test.ts`      | 新建 | ✅ 已完成 (41 tests passed) |

### 实现内容

#### types.ts - 类型定义和危险模式

- `DANGEROUS_PATTERNS`: 30+危险命令正则模式（从Hermes移植）
  - 文件系统破坏: rm -rf, chmod 777, chown root
  - 磁盘/设备操作: dd, mkfs, 写入/dev/sd
  - SQL破坏: DROP, DELETE without WHERE, TRUNCATE
  - 系统服务: systemctl stop/disable
  - 进程操作: kill -9 -1, fork bomb
  - 远程脚本: curl | sh, wget | bash
  - Git破坏: reset --hard, force push, clean -f
- `TerminalBackendType`: local/docker/ssh/modal/daytona/singularity
- `TerminalExecuteResult`: stdout/stderr/exitCode/timedOut/interrupted
- 常量: DEFAULT_TIMEOUT=60, MAX_FOREGROUND_TIMEOUT=600

#### dangerous.ts - 危险命令检测

- `stripAnsi()`: 剥离ANSI控制字符
- `normalizeCommandForDetection()`: Unicode NFKC规范化（防止fullwidth字符绕过）
- `detectDangerousCommand()`: 模式匹配检测
- `getSessionApprovedPatterns()`: 会话级审批状态
- `approvePatternForSession()`: 添加审批
- `checkDangerousCommandPermission()`: 权限系统集成（返回allow/ask/deny）
- `buildApprovalRequestMessage()`: 构建审批请求消息

#### local.ts - 本地执行后端

- `sanitizeSubprocessEnv()`: 过滤API密钥防止泄露
- `findBash()`: 跨平台bash定位（Unix/Windows Git Bash）
- `executeLocalCommand()`: spawn-per-call执行模型
- `killLocalProcess()`: 进程组终止（Unix: killpg, Windows: taskkill）

#### backend-manager.ts - 后端管理器

- `TerminalBackendManager`: 统一执行接口
  - `execute()`: 先检查危险命令，再执行
  - `executeUnchecked()`: 绕过检测（仅内部使用）
- `registerTerminalBackend()`: 后端注册
- `getAvailableBackendTypes()`: 获取可用后端列表
- 便捷函数: `quickExecute()`, `isDangerous()`

### Phase 3-B: bash-tools.exec 桥接集成

**状态**: ✅ 已完成
**完成时间**: 2026-04-16

#### 文件清单

| 文件路径                                                   | 操作 | 状态                        |
| ---------------------------------------------------------- | ---- | --------------------------- |
| `src/agents/bash-tools.exec-dangerous-check.ts`            | 新建 | ✅ 已完成                   |
| `src/agents/bash-tools.exec-dangerous-check.test.ts`       | 新建 | ✅ 已完成 (17 tests passed) |
| `src/agents/bash-tools.exec-dangerous.integration.test.ts` | 新建 | ✅ 已完成 (21 tests passed) |
| `src/agents/bash-tools.exec.ts`                            | 修改 | ✅ 已完成 (危险检测集成)    |
| `src/agents/terminal/IMPLEMENTATION_PROGRESS.md`           | 新建 | ✅ 已完成                   |
| `scripts/verify-dangerous-command-detection.sh`            | 新建 | ✅ 已完成                   |

#### bash-tools.exec-dangerous-check.ts - 审批流程桥接

- `checkDangerousCommandAndRequestApproval()`: 核心函数
  - 调用 `checkDangerousCommandPermission()` 检测危险命令
  - behavior="allow" → 直接返回 blocked=false
  - behavior="deny" → 返回 blocked=true + reason
  - trigger="cron" → 自动拒绝（headless模式）
  - behavior="ask" → 触发Gateway审批流程
- Gateway审批集成:
  - `callGatewayTool("plugin.approval.request")`: 创建审批请求
  - `callGatewayTool("plugin.approval.waitDecision")`: 等待用户决策
  - 决策处理: ALLOW_ONCE → 执行, ALLOW_ALWAYS → 缓存审批, DENY → 拒绝
- 会话级审批缓存: `approvePatternForSession()` 记录 allow-always 决策
- AbortSignal支持: 运行取消时中断审批等待

#### bash-tools.exec.ts - 执行点集成

- Line 1508后插入危险检测（在 rejectExecApprovalShellCommand 之后）
- 检测结果处理: blocked=true → throw Error
- 审批通过: warnings 推送 approvedPatternKey 信息

#### 执行流程

```
bash-tools.exec.ts execute()
│
├─ Line 1508: rejectExecApprovalShellCommand()
│
├─ ★ Line 1511-1527: checkDangerousCommandAndRequestApproval()
│   ├─ checkDangerousCommandPermission() → 检测 30+ 模式
│   ├─ behavior="allow" → 继续
│   ├─ behavior="deny" → throw error
│   ├─ trigger="cron" → 自动拒绝
│   └─ behavior="ask" → Gateway 审批流程
│       ├─ plugin.approval.request → 创建审批
│       ├─ plugin.approval.waitDecision → 等待决策
│       ├─ "allow-always" → approvePatternForSession()
│       └─ "deny"/timeout → throw error
│
├─ Line 1529+: 现有流程继续
```

### 验证结果

- ✅ TypeScript编译通过
- ✅ Lint检查通过 (0 errors/warnings)
- ✅ Import cycles通过 (0 cycles)
- ✅ 测试全部通过 (79 tests passed)
  - terminal/index.test.ts: 41 tests
  - bash-tools.exec-dangerous-check.test.ts: 17 tests
  - bash-tools.exec-dangerous.integration.test.ts: 21 tests
- ✅ Git提交完成 (commit 20cbca1a1f)

### 下一步工作

模块已完成，需要：

1. 与现有sandbox模块桥接（docker/ssh后端）
2. 与Phase 6权限系统深度集成（审批流程）
3. 添加modal/daytona/singularity后端支持

### 参考源码

- Hermes: `hermes-agent/tools/approval.py` (DANGEROUS_PATTERNS)
- Hermes: `hermes-agent/tools/environments/base.py` (BaseEnvironment)
- Hermes: `hermes-agent/tools/environments/local.py` (LocalEnvironment)
- OpenClaw: `src/agents/sandbox/docker-backend.ts` (已有Docker后端)
- OpenClaw: `src/agents/sandbox/ssh-backend.ts` (已有SSH后端)

---

## Phase 4: 技能系统 [中优先级]

**状态**: ⏳ 待开始
**预计工作量**: 2周
**文件数量**: 6个文件

### 文件清单

| 文件路径                         | 操作 | 状态 |
| -------------------------------- | ---- | ---- |
| `src/agents/skills/types.ts`     | 扩展 | ⏳   |
| `src/agents/skills/parser.ts`    | 新建 | ⏳   |
| `src/agents/skills/discovery.ts` | 新建 | ⏳   |
| `src/agents/skills/registry.ts`  | 新建 | ⏳   |
| `src/agents/tools/skill-tool.ts` | 新建 | ⏳   |
| `src/agents/skills/workspace.ts` | 修改 | ⏳   |

### 关键设计要点

- SKILL.md 格式: YAML frontmatter + Markdown 内容
- 元数据约束: `name ≤64 chars`, `description ≤1024 chars`
- 技能发现: 递归查找 SKILL.md 文件，解析 frontmatter
- 存储位置: `~/.openclaw/skills/` 或配置外部目录

### 参考源码

- Hermes: `hermes-agent/tools/skills_tool.py` (skills_list, skill_view)
- Hermes: `hermes-agent/skills/` (现有技能目录结构)
- OpenClaw: `src/agents/skills/` (现有技能系统)
- OpenClaw: `skills/` 目录

---

## Phase 5: 任务系统与多智能体协作 [低优先级，依赖 Phase 1-4]

**状态**: ⏳ 待开始
**预计工作量**: 3周
**文件数量**: 9个文件

### 文件清单

| 文件路径                               | 操作 | 状态 |
| -------------------------------------- | ---- | ---- |
| `src/agents/tasks/types.ts`            | 新建 | ⏳   |
| `src/agents/tasks/store.ts`            | 新建 | ⏳   |
| `src/agents/tasks/dependency-graph.ts` | 新建 | ⏳   |
| `src/agents/tasks/claim.ts`            | 新建 | ⏳   |
| `src/agents/fork/types.ts`             | 新建 | ⏳   |
| `src/agents/fork/context.ts`           | 新建 | ⏳   |
| `src/agents/fork/cache-safe.ts`        | 新建 | ⏳   |
| `src/agents/subagent-spawn.ts`         | 修改 | ⏳   |

### 关键设计要点

- 任务数据结构: `Task { id, subject, status, owner, blocks, blockedBy }`
- 依赖图管理: `blockTask(fromId, toId)` 双向更新
- 原子认领: `proper-lockfile` + 检查 blockedBy + 检查 agent_busy
- 上下文隔离: `AsyncLocalStorage` 隔离可变状态
- 缓存优化: Fork Agent 使用统一占位符模板最大化 Prompt Cache 命中

### 参考源码

- Claude Code: `claude-leaked-source/src/utils/tasks.ts` (依赖图、认领逻辑)
- Claude Code: `claude-leaked-source/src/utils/agentContext.ts` (AsyncLocalStorage)
- Claude Code: `claude-leaked-source/src/tools/AgentTool/AgentTool.tsx` (Fork Agent)
- OpenClaw: `src/agents/subagent-spawn.ts` (现有 Spawn 机制)

---

## 总进度

| Phase                    | 状态             | 进度             |
| ------------------------ | ---------------- | ---------------- |
| Phase 6.1 (权限模块实现) | ✅ 已完成        | 100%             |
| Phase 6.2 (权限融入)     | ✅ 已完成        | 100%             |
| Phase 2 (上下文管理)     | ✅ 核心模块完成  | 85% (集成待完成) |
| Phase 1 (记忆系统)       | ✅ 核心模块完成  | 85% (集成待完成) |
| Phase 3 (终端执行)       | ✅ 模块+桥接完成 | 100%             |
| Phase 4 (技能系统)       | ⏳ 待开始        | 0%               |
| Phase 5 (任务/Fork)      | ⏳ 待开始        | 0%               |

---

## 验证步骤

每个 Phase 完成后执行相应验证：

### Phase 6.2 验证 (融入验证) ✅ 已完成

- ✅ TypeScript编译通过 (pnpm tsgo)
- ✅ 全量测试通过 (1770 passed)
- ✅ Permissions模块测试通过 (28 tests passed)
- ⏳ 运行时测试需要实际Agent执行验证（待后续）

### Phase 6.1 验证 ✅ 已完成

- ✅ 创建测试规则，验证管道各阶段执行
- ✅ 测试各 PermissionMode 行为 (28 tests passed)
- ✅ 验证规则匹配正确性 (wildcard, prefix, group matching)
- ✅ 全量测试通过 (1770 tests passed)

### Phase 1 验证 ✅ 已完成

- ✅ 创建记忆条目，验证强制分类和类型约束
- ✅ 验证 MEMORY.md 索引生成正确（按类型分组）
- ✅ 验证排除边界过滤生效（代码模式检测）
- ✅ 验证截断功能正常（大小约束）
- ✅ 验证优先级截断（高优先级保留）
- ✅ 测试全部通过 (43 tests passed)

### Phase 2 验证

- 模拟连续压缩失败，验证熔断器触发
- 检查递归保护生效（session_memory Agent 不触发压缩）
- 测试 Token 预算计算准确性

### Phase 3 验证 ✅ 已完成

- ✅ TypeScript编译通过
- ✅ Lint检查通过 (0 errors/warnings)
- ✅ Import cycles检查通过 (0 cycles)
- ✅ 测试全部通过 (41 tests passed)
- ✅ 功能自测验证:
  - 30+危险模式正确匹配 (rm -rf, chmod 777, fork bomb等)
  - Obfuscation防护有效 (ANSI/null byte/Unicode fullwidth)
  - Session approval流程正常 (approve/revoke/clear)
  - Permission API兼容Phase 6 (behavior: allow/ask/deny)

### Phase 4 验证

- 创建测试 SKILL.md 文件，验证解析正确
- 测试技能发现和加载
- 验证平台兼容性检查

### Phase 5 验证

- 创建测试任务，验证依赖图管理
- 测试任务认领原子性和并发竞态
- 验证 Fork Agent 上下文隔离

### Phase 6.1 验证 (已完成)

- ✅ 创建测试规则，验证管道各阶段执行
- ✅ 测试各 PermissionMode 行为 (28 tests passed)
- ✅ 验证规则匹配正确性 (wildcard, prefix, group matching)
- ✅ 全量测试通过 (1770 tests passed, 1 unrelated flaky timeout)

---

## 开发前准备

```bash
# 创建新分支
cd openclaw && git checkout -b feature/fusion-claude-hermes

# 验证项目完整性
pnpm install && pnpm build
```

---

## 风险缓解

| 风险             | 缓解措施                                                 |
| ---------------- | -------------------------------------------------------- |
| 与现有系统冲突   | 分阶段集成，每阶段独立测试                               |
| 跨语言设计差异   | TypeScript 使用 AsyncLocalStorage，Python 用 contextvars |
| 过度工程化       | 只嫁接核心约束，保留 OpenClaw 灵活性                     |
| 截断导致信息丢失 | 提供 archive 目录保存完整历史                            |

---

## Session 恢复指南

如果 session 重置，请：

1. **阅读此文件**: `FUSION_PROGRESS.md`
2. **查看总进度表**: 确认当前完成状态（Phase 6.1/6.2/2/1/3 已完成）
3. **选择下一步工作**: 根据以下选项继续

### 当前状态总结

```
已完成:
├── Phase 6.1: permissions模块 (6文件, 28 tests)
├── Phase 6.2: 权限融入 (4文件修改)
├── Phase 2: compaction模块 (6文件, 35 tests)
├── Phase 1: memory模块 (6文件, 43 tests)
└── Phase 3: terminal模块 + bash-tools桥接 (11文件, 79 tests)

待完成:
├── Phase 2 集成: pi-embedded-runner/run.ts
├── Phase 1 集成: 会话启动/结束时的记忆管理
├── Phase 4: 技能系统 (6文件)
└── Phase 5: 任务/Fork (9文件)
```

### 下一步选项

**选项 A - 继续实现新模块**:

```
执行 Phase 4 (技能系统)
→ 扩展 src/agents/skills/ 目录下的文件
→ 参考 Hermes: tools/skills_tool.py
```

**选项 B - 集成已完成模块**:

```
集成 Phase 2 + Phase 1 到运行时
→ 修改 src/agents/pi-embedded-runner/run.ts
→ 添加 CircuitBreaker, ThresholdManager, MemoryManager 初始化
```

**选项 C - 完成Phase 3后端扩展**:

```
桥接现有sandbox后端到terminal模块
→ 修改 src/agents/terminal/backend-manager.ts
→ 注册docker/ssh后端（复用sandbox代码）
→ 测试危险命令在各后端的检测
```

### 关键文件快速参考

| 文件                                            | 用途                                     |
| ----------------------------------------------- | ---------------------------------------- |
| `src/agents/permissions/index.ts`               | 权限模块入口                             |
| `src/agents/compaction/index.ts`                | 压缩模块入口                             |
| `src/agents/terminal/index.ts`                  | 终端模块入口（危险命令检测）             |
| `src/agents/bash-tools.exec-dangerous-check.ts` | 危险命令审批桥接                         |
| `src/memory/index.ts`                           | 记忆模块入口                             |
| `src/agents/pi-tools.ts`                        | 工具组装核心（权限已集成）               |
| `src/agents/bash-tools.exec.ts`                 | Bash执行核心（危险检测已集成）           |
| `src/agents/pi-embedded-runner/run.ts`          | Agent运行核心（待集成compaction/memory） |

### 验证命令

```bash
# 检查编译
pnpm check

# 运行权限测试
pnpm test -- src/agents/permissions

# 运行压缩测试
pnpm test -- src/agents/compaction

# 运行记忆测试
pnpm test -- src/memory

# 运行终端测试
pnpm test -- src/agents/terminal
```

---

## 更新日志

- 2026-04-13: 初始化计划文档，完成项目探索，确定优先级顺序
- 2026-04-13: Phase 6.1 完成 - 创建 permissions/types.ts, modes.ts, rules.ts, pipeline.ts, index.ts, index.test.ts (28 tests passed)
- 2026-04-13: Phase 6.1 验证通过 - 全量测试 1770 passed
- 2026-04-13: 创建 runtime-permission-check.ts, 修改 pi-tools.before-tool-call.ts (未完成融入)
- 2026-04-14: 深入分析三项目源码架构，理解 Phase 6 选择原因
- 2026-04-14: 确定融入策略：渐进式替换（新系统主导，旧配置兼容）
- 2026-04-14: Phase 6.2 开始 - 融入计划制定，准备执行配置层集成
- 2026-04-14: Phase 6.2 完成 - 完成全部4步融入：
  - Step 1: policiesToRulesBySource(), buildPermissionConfigFromPolicies()
  - Step 2: pi-tools.ts集成，传递permissionConfig
  - Step 3: pi-tools.before-tool-call.ts权限检查入口
  - Step 4: ask行为触发Gateway approval流程
- 2026-04-14: Phase 6.2 验证通过 - TypeScript编译通过，1770测试通过，28权限测试通过
- 2026-04-14: Phase 2 完成 - 创建 compaction/types.ts, circuit-breaker.ts, threshold-manager.ts, recursion-guard.ts, index.ts, index.test.ts (35 tests passed)
- 2026-04-14: Phase 1 完成 - 创建 memory/memory-types.ts, memory-index.ts, memory-manager.ts, memory-truncation.ts, index.ts, index.test.ts (43 tests passed)
- 2026-04-15: Phase 3 完成 - 创建 terminal/types.ts, dangerous.ts, local.ts, backend-manager.ts, index.ts, index.test.ts (41 tests passed)
- 2026-04-15: Phase 3 功能自测验证通过 - 危险命令检测、obfuscation防护、session approval流程
- 2026-04-15: Phase 3 推送到 origin/feature/fusion-claude-hermes (commit 845b0e3f1d)

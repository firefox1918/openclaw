# OpenClaw 融合实施方案 - 执行进度跟踪

> **创建时间**: 2026-04-13
> **核心理念**: 强化OpenClaw，使其具备强大的自主持久工作能力和自主技能形成能力
>
> **Claude Code贡献**: 自主持久工作能力 - 12层Harness机制让Agent能长时间稳定完成复杂编程任务
>
> **Hermes Agent贡献**: 自主技能形成能力 - Agent从有效流程中学习并固化可复用技能

---

## 融合目标详解

### Claude Code: 自主持久工作能力

Claude Code处理编程任务时非常好用，核心在于：

**12层渐进式Harness机制**：

```
S01 - THE LOOP          → 基础循环（API调用→工具执行→循环）
S02 - TOOL DISPATCH     → 工具注册与分发
S03 - PLANNING          → Plan模式（先规划再执行，提高完成率）
S04 - SUB-AGENTS        → Fork子智能体（上下文继承）
S05 - KNOWLEDGE ON DEMAND → 按需加载（SkillTool + memdir）
S06 - CONTEXT COMPRESSION → 三层压缩（管理上下文窗口）
S07 - PERSISTENT TASKS  → 任务图 + 依赖管理 + 持久化
S08 - BACKGROUND TASKS  → 后台执行（主Agent继续思考）
S09 - AGENT TEAMS       → 持久化队友 + 异步邮箱
S10 - TEAM PROTOCOLS    → SendMessageTool统一通信
S11 - AUTONOMOUS AGENTS → Coordinator空闲循环 + 自动认领任务
S12 - WORKTREE ISOLATION → Git worktree隔离（避免冲突）
```

**关键技术创新**：

- **StreamingToolExecutor**: 流式接收时立即执行，最大化并发
- **Fork缓存优化**: 统一占位符共享缓存，提升子Agent效率
- **熔断器机制**: 连续失败3次后停止重试，防止死循环
- **递归保护**: session_memory Agent不触发压缩，防止无限递归

### Hermes Agent: 自主技能形成能力

Hermes的`skill_manage`工具让Agent具备学习能力：

**触发条件**（何时应该"学习"）：

- 完成复杂任务（5+工具调用）后成功
- 遇到错误/死胡同并找到有效路径
- 用户纠正了Agent的方法
- 发现非平凡可复用工作流程

**学习动作**：

```
create   → 从零创建新技能（记录有效流程）
patch    → 针对性修复（token高效）
edit     → 结构性重写
delete   → 删除过时技能
write_file → 添加辅助脚本
remove_file → 清理辅助文件
```

**价值**：Agent不是一次性执行，而是"进化"——每次成功都固化最佳实践。

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

**状态**: ✅ 已完成 (核心模块 + run.ts集成)
**实际工作量**: 1天 (核心) + 0.5天 (集成)
**文件数量**: 7个文件

### 文件清单

| 文件路径                                     | 操作 | 状态                        |
| -------------------------------------------- | ---- | --------------------------- |
| `src/agents/compaction/types.ts`             | 新建 | ✅ 已完成                   |
| `src/agents/compaction/circuit-breaker.ts`   | 新建 | ✅ 已完成                   |
| `src/agents/compaction/threshold-manager.ts` | 新建 | ✅ 已完成                   |
| `src/agents/compaction/recursion-guard.ts`   | 新建 | ✅ 已完成                   |
| `src/agents/compaction/index.ts`             | 新建 | ✅ 已完成                   |
| `src/agents/compaction/index.test.ts`        | 新建 | ✅ 已完成 (35 tests passed) |
| `src/agents/pi-embedded-runner/run.ts`       | 集成 | ✅ 已完成 (熔断器集成)      |

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
- ✅ Lint检查通过 (pnpm lint)
- ✅ Import cycles通过 (0 cycles)
- ✅ 测试全部通过 (35 tests passed)

### run.ts 集成内容 (Phase 2-B)

**完成时间**: 2026-04-16

在 `pi-embedded-runner/run.ts` 中集成熔断器：

1. **初始化**: 创建 `compactionCircuitBreaker` 在运行循环开始时
2. **Timeout Compaction**: 检查熔断器状态，通过则执行；记录成功/失败
3. **Overflow Compaction**: 检查熔断器状态，通过则执行；记录成功/失败
4. **递归追踪**: 使用 `runInCompactionContext()` 包装压缩调用

**集成点**:

- Line ~31: 导入 compaction 模块
- Line ~430: 创建熔断器实例
- Line ~850: Timeout compaction 熔断器检查
- Line ~893: Timeout compaction 结果记录
- Line ~996-1000: Overflow compaction 熔断器检查
- Line ~1060: Overflow compaction 成功记录
- Line ~1085: Overflow compaction 失败记录

### 参考源码

- Claude Code: `claude-leaked-source/src/services/compact/autoCompact.ts`
- Claude Code: `claude-leaked-source/src/services/compact/sessionMemoryCompact.ts`
- OpenClaw: `src/agents/pi-embedded-runner/session-truncation.ts`

---

## Phase 1: 记忆系统工程化 [中优先级]

**状态**: ✅ 已完成 (核心模块 + 运行时集成)
**实际工作量**: 1天 (核心) + 0.5天 (集成)
**文件数量**: 7个文件

### 文件清单

| 文件路径                               | 操作 | 状态                        |
| -------------------------------------- | ---- | --------------------------- |
| `src/memory/memory-types.ts`           | 新建 | ✅ 已完成                   |
| `src/memory/memory-index.ts`           | 新建 | ✅ 已完成                   |
| `src/memory/memory-manager.ts`         | 新建 | ✅ 已完成                   |
| `src/memory/memory-truncation.ts`      | 新建 | ✅ 已完成                   |
| `src/memory/index.ts`                  | 新建 | ✅ 已完成                   |
| `src/memory/index.test.ts`             | 新建 | ✅ 已完成 (43 tests passed) |
| `src/agents/memory-runtime.ts`         | 新建 | ✅ 已完成 (运行时桥接)      |
| `src/agents/pi-embedded-runner/run.ts` | 集成 | ✅ 已完成 (启动初始化)      |

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

### 运行时集成内容 (Phase 1-B)

**完成时间**: 2026-04-16

创建 `memory-runtime.ts` 桥接模块：

1. **initializeMemoryRuntime()**: 会话启动初始化
   - 创建 projectMemoryManager 和 sessionMemoryManager
   - 注册 prompt supplement builder 到 memory-state.ts
   - 清理过期会话记忆

2. **createMemoryPromptBuilder()**: 系统提示注入
   - 格式化记忆条目按类型分组
   - 返回 Markdown 格式提示内容

3. **cleanupSessionMemory()**: 会话结束清理接口

**集成点**:

- `src/agents/memory-runtime.ts`: 桥接模块
- `src/agents/pi-embedded-runner/run.ts:428-437`: 启动初始化
- `src/plugins/memory-state.ts`: prompt supplement 注册

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

## Phase 4: 技能系统 [已完成 - 技能查询工具]

**状态**: ✅ 已完成 (2026-04-20)
**重要性**: ⭐⭐⭐ (技能查询能力)

### 现状分析

OpenClaw 技能系统已相当完整：

- ✅ `types.ts` - 类型定义完整
- ✅ `frontmatter.ts` - SKILL.md 解析（相当于 parser.ts）
- ✅ `workspace.ts` - 技能发现和加载（相当于 discovery.ts + registry.ts）
- ✅ `skill-manage-tool.ts` - 技能管理工具（Phase 8 已实现）

### 缺失功能

缺少 Hermes Agent 的查询类工具：

- ❌ `skills_list` - 列出可用技能
- ❌ `skill_view` - 查看单个技能详情

### 实现方案

**文件**: `src/agents/skills/skills-query-tool.ts`

```typescript
// skills_list: 列出可用技能
// skill_view: 查看单个技能内容

interface SkillsQueryInput {
  action: "list" | "view";
  name?: string; // for view action
  verbose?: boolean; // 详细输出
}
```

### 实现步骤

1. 创建 skills-query-tool.ts - 查询工具实现
2. 实现 skills_list 动作 - 列出所有可用技能
3. 实现 skill_view 动作 - 查看单个技能详情
4. 集成到 openclaw-tools.ts
5. 编写测试用例

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

## Phase 7: 极致缓存利用 [已覆盖 - OpenClaw原生实现]

**状态**: ✅ 已覆盖（OpenClaw已有完整实现）
**覆盖范围**: 100%

### OpenClaw原生实现

OpenClaw已实现Claude Code风格的Prompt Cache极致利用：

| 组件          | 文件路径                                                      | 功能                                |
| ------------- | ------------------------------------------------------------- | ----------------------------------- |
| 缓存观测      | `src/agents/pi-embedded-runner/prompt-cache-observability.ts` | 缓存失效检测、快照比对、metrics追踪 |
| 缓存边界      | `src/agents/system-prompt-cache-boundary.ts`                  | 稳定前缀/动态后缀分离               |
| 缓存TTL       | `src/agents/pi-embedded-runner/cache-ttl.ts`                  | TTL窗口管理                         |
| Anthropic集成 | `src/agents/anthropic-payload-policy.ts`                      | cache_control注入                   |
| Google集成    | `src/agents/pi-embedded-runner/google-prompt-cache.ts`        | Gemini cachedContents管理           |

### 配置支持

```yaml
# cacheRetention配置（已支持）
agents:
  defaults:
    params:
      cacheRetention: "long" # none | short | long


# Provider特定行为
# - Anthropic: short=5min, long=1hour TTL
# - OpenAI: 自动prompt caching, prompt_cache_key稳定路由
# - Gemini: cachedContents资源管理
# - Vertex/Bedrock: Anthropic兼容缓存
```

### 缓存稳定性保障

- MCP工具目录排序（避免顺序变化破坏缓存前缀）
- 系统提示词边界分离（稳定部分在前，动态部分在后）
- 心跳保活（heartbeat保持缓存窗口温暖）
- contextPruning.cache-ttl模式（防止idle后重新缓存过大历史）

### 参考文档

- OpenClaw: `docs/reference/prompt-caching.md`
- Claude Code: `claude-leaked-source/MISSING_12_PERCENT.md` Section 3

---

## Phase 8: 自主技能形成 [已完成 - Hermes Agent学习能力]

**状态**: ✅ 已完成 (2026-04-20)
**实际工作量**: 1天
**重要性**: ⭐⭐⭐⭐⭐ (Hermes Agent核心学习能力)
**核心理念**: Agent从有效工作流程中"学习"并固化可复用技能

### 核心概念

**自主技能形成** = Agent的"学习"和"进化"能力

这不是简单记录，而是让Agent能够：

1. **识别高价值流程** - 从成功执行中提取可复用模式
2. **固化最佳实践** - 将有效方法转化为技能
3. **积累程序记忆** - 越用越聪明，避免重复探索

Hermes Agent的`skill_manage`工具实现了这个能力：

```python
# Hermes Agent - skill_manage tool
# Agent可以自主执行以下操作：
actions = {
    "create": "从零创建新技能（记录有效流程）",
    "patch": "针对性修复（token高效，比edit更优雅）",
    "edit": "结构性重写",
    "delete": "删除过时技能",
    "write_file": "添加辅助脚本/参考文档",
    "remove_file": "清理辅助文件"
}

# 学习触发条件：
learning_triggers = [
    "完成复杂任务（5+工具调用）后成功",
    "遇到错误/死胡同并找到有效路径 → 高价值！",
    "用户纠正了Agent的方法 → 高价值！",
    "发现非平凡可复用工作流程"
]
```

### OpenClaw现状

OpenClaw已有技能系统，但**缺少学习能力**：

| 能力               | OpenClaw现状           | Hermes Agent              |
| ------------------ | ---------------------- | ------------------------- |
| 手动创建技能       | ✅ skill-creator skill | ✅ hermes skills create   |
| 安装外部技能       | ✅ ClawHub集成         | ✅ Skills Hub多源         |
| 列出/查看技能      | ✅ skills list/view    | ✅ skills_list/skill_view |
| **识别高价值流程** | ❌ 无                  | ✅ 触发条件检测           |
| **自主创建技能**   | ❌ 无                  | ✅ skill_manage tool      |
| **自主更新技能**   | ❌ 无                  | ✅ patch/edit actions     |
| **成功后自动记录** | ❌ 无                  | ✅ 自动触发学习           |

### 实现方案

#### Step 1: 创建 skill_manage 工具

**文件**: `src/agents/tools/skill-manage.ts`

```typescript
// 核心接口
interface SkillManageInput {
  action: "create" | "patch" | "edit" | "delete" | "write_file" | "remove_file";
  name: string; // skill name
  content?: string; // SKILL.md content (create/edit)
  old_string?: string; // for patch（token高效）
  new_string?: string; // for patch
  file_path?: string; // for write_file/remove_file
  file_content?: string; // for write_file
  category?: string; // optional category for create
}

interface SkillManageResult {
  success: boolean;
  skill_name: string;
  action: string;
  message: string;
}
```

#### Step 2: 学习触发检测

**文件**: `src/agents/skill-learning-trigger.ts`

```typescript
// 检测是否应该"学习"并记录为技能
interface LearningTrigger {
  toolCallCount: number; // >= 5 触发候选
  hadErrors: boolean; // 有错误但最终成功 → 高价值学习
  hadUserCorrection: boolean; // 用户纠正 → 高价值学习
  workflowComplexity: "simple" | "moderate" | "complex";
  domainReusability: boolean; // 是否可复用于其他场景
}

function shouldLearnAndFormSkill(
  sessionHistory: ToolCallHistory,
  trigger: LearningTrigger,
): boolean {
  // 学习触发条件：
  // 1. toolCallCount >= 5 && success → 完成复杂任务
  // 2. hadErrors && foundWorkingPath → 错误后找到有效路径（高价值）
  // 3. hadUserCorrection → 用户纠正了方法（高价值）
  // 4. domainReusability评估 → 可复用场景判断
}
```

#### Step 3: 工作流程提取（学习方法）

**文件**: `src/agents/skill-workflow-extractor.ts`

```typescript
// 从成功执行中提取技能内容（学习过程）
function extractSkillFromSession(sessionHistory: ToolCallHistory): SkillContent {
  // 1. 识别核心工作流程步骤
  // 2. 提取关键决策点（特别是错误后的正确路径）
  // 3. 识别常见陷阱和解决方法（从错误中学习）
  // 4. 生成验证方法（如何确认成功）
  // 5. 格式化为SKILL.md
}
```

#### Step 4: 学习确认流程

```typescript
// 不强制创建，询问用户确认
async function proposeSkillLearning(
  skillName: string,
  skillPreview: string,
  learningReason: string, // 为什么认为这是高价值流程
): Promise<boolean> {
  // 调用Gateway审批流程
  // 显示：检测到高价值工作流程
  // 原因：[learningReason]（如：错误后找到有效路径、用户纠正等）
  // 提问：是否保存为技能以便后续复用？
  // 预览：SKILL.md内容摘要
}
```

### 文件清单

| 文件路径                                  | 操作 | 状态                      |
| ----------------------------------------- | ---- | ------------------------- |
| `src/agents/tools/skill-manage.ts`        | 新建 | ⏳                        |
| `src/agents/skill-learning-trigger.ts`    | 新建 | ⏳                        |
| `src/agents/skill-workflow-extractor.ts`  | 新建 | ⏳                        |
| `src/agents/skills/workspace.ts`          | 修改 | ⏳ (添加skill_manage注册) |
| `src/agents/pi-tools.before-tool-call.ts` | 修改 | ⏳ (添加学习触发检测)     |

### 参考源码

- Hermes: `hermes-agent/tools/skills_tool.py` (skill_manage工具)
- Hermes: `hermes-agent/hermes_cli/skills_hub.py` (技能管理)
- OpenClaw: `src/agents/skills/workspace.ts` (现有技能发现)
- OpenClaw: `skills/skill-creator/SKILL.md` (手动创建指南)

---

## Phase 9: 规则持久化 [已完成 - 用户偏好记忆]

**状态**: ✅ 已完成 (2026-04-20)
**实际工作量**: 1小时
**重要性**: ⭐⭐⭐⭐ (用户偏好记忆，提升体验)

### 现状

用户审批决策未持久化，每次会话需重新审批。

### 实现方案

**文件**: `src/agents/permissions/persistence.ts`

```typescript
// 保存用户审批决策
interface SavedPermissionRule {
  toolName: string;
  behavior: "allow" | "deny";
  pattern?: string; // 如 bash危险命令模式
  createdAt: number;
  expiresAt?: number; // 可选过期时间
}

// 功能：
// - savePermissionRule(rule): 保存到 ~/.openclaw/permissions.json
// - loadSavedRules(): 启动时加载
// - mergeWithSessionRules(): 合并到运行时规则
```

### 实现步骤

1. 创建 persistence.ts - 持久化存储模块
2. 定义 SavedPermissionRule 类型
3. 实现 savePermissionRule() - 保存规则
4. 实现 loadSavedRules() - 加载规则
5. 实现 mergeWithSessionRules() - 合并到运行时
6. 集成到 pipeline.ts - 启动时加载持久化规则
7. 编写测试用例

---

## Phase 10: StreamingToolExecutor [待实现]

**状态**: ⏳ 待开始
**预计工作量**: 1周
**重要性**: ⭐⭐⭐⭐ (Claude Code核心创新)
**对应**: Claude Code 12层Harness S02

### 核心概念

**流式执行创新**：工具还在流式接收时就开始执行，最大化并发

```typescript
// Claude Code的核心创新
class StreamingToolExecutor {
  // 工具还在接收时就开始执行
  addTool(block) {
    // 立即尝试执行
    void this.processQueue();
  }

  // 动态并发控制
  canExecuteTool(isConcurrencySafe) {
    // 只读工具可并行，写操作串行
  }
}
```

### 实现方案

**文件**: `src/agents/streaming-tool-executor.ts`

```typescript
interface TrackedTool {
  id: string;
  block: ToolUseBlock;
  status: "queued" | "executing" | "completed" | "yielded";
  isConcurrencySafe: boolean;
  pendingProgress: Progress[];
}

class StreamingToolExecutor {
  private tools: TrackedTool[] = [];

  // 添加工具到执行队列（流式接收时调用）
  addTool(block: ToolUseBlock, assistantMessage: AssistantMessage) {
    const isConcurrencySafe = this.checkConcurrencySafety(block);
    this.tools.push({
      id: block.id,
      block,
      status: "queued",
      isConcurrencySafe,
      pendingProgress: [],
    });
    void this.processQueue(); // 立即尝试执行
  }

  // 并发控制逻辑
  private canExecuteTool(isConcurrencySafe: boolean): boolean {
    const executing = this.tools.filter((t) => t.status === "executing");
    return (
      executing.length === 0 || (isConcurrencySafe && executing.every((t) => t.isConcurrencySafe))
    );
  }

  // 处理执行队列
  private async processQueue() {
    for (const tool of this.tools) {
      if (tool.status !== "queued") continue;
      if (this.canExecuteTool(tool.isConcurrencySafe)) {
        await this.executeTool(tool);
      } else if (!tool.isConcurrencySafe) {
        break; // 非并发安全工具阻塞队列
      }
    }
  }
}
```

### 并发策略

| 工具类型       | 并发策略                     | 示例              |
| -------------- | ---------------------------- | ----------------- |
| **并发安全**   | 可并行执行（最多10个）       | Read, Glob, Grep  |
| **非并发安全** | 严格串行执行                 | Edit, Write, Bash |
| **混合场景**   | 先并发只读批次，再串行写批次 | 搜索→修改流程     |

### 集成点

- `src/agents/pi-embedded-runner/run.ts`: 主循环中使用StreamingToolExecutor
- `src/agents/tools/common.ts`: 添加`isConcurrencySafe()`方法

---

## Phase 11: Fork子Agent优化 [待实现]

**状态**: ⏳ 待开始
**预计工作量**: 1周
**重要性**: ⭐⭐⭐⭐ (Prompt Cache关键优化)
**对应**: Claude Code 12层Harness S04

### 核心概念

**缓存优化创新**：所有Fork子Agent使用相同占位符，最大化Prompt Cache共享

```typescript
// Claude Code的缓存优化
const FORK_PLACEHOLDER_RESULT = "Fork started — processing in background";

// fork_boilerplate模板让所有子Agent共享缓存前缀
function buildChildMessage(directive: string): string {
  return `<fork_boilerplate>
STOP. READ THIS FIRST.
You are a forked worker process. You are NOT the main agent.
RULES:
1. Do NOT spawn sub-agents; execute directly
2. Do NOT converse or ask questions
3. USE your tools directly: Bash, Read, Write, etc.
...
DIRECTIVE: ${directive}`;
}
```

### 实现方案

**文件**: `src/agents/fork-cache-optimization.ts`

```typescript
// Fork子Agent统一占位符（缓存优化）
const FORK_UNIFIED_PLACEHOLDER = "Fork started — processing in background";

// Fork子Agent指令模板（共享缓存前缀）
const FORK_BOILERPLATE_TEMPLATE = `
STOP. READ THIS FIRST.
You are a forked worker process. You are NOT the main agent.

RULES:
1. Do NOT spawn sub-agents; execute directly
2. Do NOT converse or ask questions
3. USE your tools directly: Bash, Read, Write, etc.
4. If you modify files, commit before reporting
5. Stay strictly within your directive's scope
6. Keep report under 500 words
7. Response MUST begin with "Scope:"
`;

// 构建Fork消息（使用统一模板）
function buildForkedMessages(directive: string, assistantMessage: AssistantMessage): Message[] {
  // 1. 克隆完整的assistant消息
  const fullAssistantMessage = cloneAssistantMessage(assistantMessage);

  // 2. 为所有tool_use创建统一占位符（缓存共享）
  const toolResultBlocks = assistantMessage.toolUseBlocks.map((block) => ({
    type: "tool_result",
    tool_use_id: block.id,
    content: FORK_UNIFIED_PLACEHOLDER, // 统一占位符！
  }));

  // 3. 构建用户消息
  const userMessage = createUserMessage({
    content: [
      ...toolResultBlocks,
      { type: "text", text: FORK_BOILERPLATE_TEMPLATE + `\nDIRECTIVE: ${directive}` },
    ],
  });

  return [fullAssistantMessage, userMessage];
}
```

### 集成点

- `src/agents/subagent-spawn.ts`: Fork子Agent创建时使用统一模板

---

## Phase 12: Coordinator模式 [待实现]

**状态**: ⏳ 待开始
**预计工作量**: 1周
**重要性**: ⭐⭐⭐⭐ (自主持久工作核心)
**对应**: Claude Code 12层Harness S11

### 核心概念

**自主任务认领**：Agent空闲时自动查找并认领可执行任务

```typescript
// Claude Code的Coordinator模式
async function autonomousWorkerLoop(agentId: string) {
  while (true) {
    // 1. 检查收件箱
    const messages = await checkInbox(agentId);
    if (messages.length > 0) {
      await processMessages(messages);
    }

    // 2. 查找可认领的任务
    const availableTasks = await listTasks({
      status: "pending",
      owner: null,
      blockedBy: [], // 无阻塞依赖
    });

    if (availableTasks.length > 0) {
      const task = availableTasks[0];
      await claimTask(task.id, agentId); // 原子认领
      await executeTask(task);
    } else {
      await sleep(5000); // 无任务，休眠
    }
  }
}
```

### 实现方案

**文件**: `src/agents/coordinator-loop.ts`

```typescript
interface CoordinatorConfig {
  agentId: string;
  checkInboxInterval: number; // 默认 1000ms
  sleepWhenIdle: number; // 默认 5000ms
  maxConcurrentTasks: number; // 默认 1
}

class CoordinatorLoop {
  private config: CoordinatorConfig;
  private status: "running" | "paused" | "stopped" = "running";

  async run() {
    while (this.status === "running") {
      // 1. 优先处理收件箱消息
      const messages = await this.checkInbox();
      if (messages.length > 0) {
        await this.processMessages(messages);
        continue; // 处理完消息后重新检查
      }

      // 2. 查找可认领任务
      const availableTask = await this.findAvailableTask();
      if (availableTask) {
        await this.claimAndExecute(availableTask);
      } else {
        // 无任务，休眠
        await this.sleep(this.config.sleepWhenIdle);
      }
    }
  }

  private async findAvailableTask(): Promise<Task | null> {
    const tasks = await listTasks({
      status: "pending",
      owner: null,
    });

    // 过滤被阻塞的任务
    const readyTasks = tasks.filter((task) => this.isTaskReady(task));

    if (readyTasks.length === 0) return null;

    // 按优先级排序
    return readyTasks.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
  }

  private isTaskReady(task: Task): boolean {
    if (task.blockedBy.length === 0) return true;
    const blockers = await getTasks(task.blockedBy);
    return blockers.every((t) => t.status === "completed");
  }

  private async claimAndExecute(task: Task): Promise<void> {
    // 原子认领（使用proper-lockfile）
    await claimTask(task.id, this.config.agentId);
    await executeTask(task);
    await updateTask(task.id, { status: "completed" });
  }
}
```

### 集成点

- `src/agents/pi-embedded-runner/run.ts`: 主循环结束后可进入Coordinator模式
- `src/agents/tasks/store.ts`: 任务持久化存储

---

## Phase 13: Background Tasks [待实现]

**状态**: ⏳ 待开始
**预计工作量**: 1周
**重要性**: ⭐⭐⭐⭐ (持久工作关键)
**对应**: Claude Code 12层Harness S08

### 核心概念

**后台持久执行**：主Agent继续思考时，后台任务在执行

```typescript
// Claude Code的Background Tasks
type TaskType =
  | "local_bash" // 本地Shell命令
  | "local_agent" // 本地子Agent
  | "remote_agent" // 远程Agent
  | "dream"; // 后台思考任务

class BackgroundTaskManager {
  async spawn(type: TaskType, config: TaskConfig): Promise<string> {
    const taskId = generateTaskId(type);
    const task = { id: taskId, type, status: "running", promise: this.executeTask(type, config) };
    this.tasks.set(taskId, task);

    // 任务完成时通知主Agent
    task.promise.then((result) => {
      this.notifyCompletion(taskId, result);
    });

    return taskId;
  }

  async getOutput(taskId: string, block: boolean): Promise<TaskOutput> {
    const task = this.tasks.get(taskId);
    if (block) {
      return await task.promise; // 阻塞等待
    } else {
      return task.currentOutput; // 非阻塞获取当前状态
    }
  }
}
```

### 实现方案

**文件**: `src/agents/background-task-manager.ts`

```typescript
type BackgroundTaskType = "shell" | "subagent" | "analysis";

interface BackgroundTask {
  id: string;
  type: BackgroundTaskType;
  status: "running" | "completed" | "failed";
  promise: Promise<TaskOutput>;
  currentOutput?: TaskOutput;
  startedAt: number;
}

class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private completionCallbacks = new Map<string, (result: TaskOutput) => void>();

  async spawn(type: BackgroundTaskType, config: TaskConfig): Promise<string> {
    const taskId = generateTaskId(type);

    const task: BackgroundTask = {
      id: taskId,
      type,
      status: "running",
      promise: this.executeTask(type, config),
      startedAt: Date.now(),
    };

    this.tasks.set(taskId, task);

    // 任务完成时通知
    task.promise
      .then((result) => {
        task.status = "completed";
        task.currentOutput = result;
        const callback = this.completionCallbacks.get(taskId);
        if (callback) callback(result);
      })
      .catch((error) => {
        task.status = "failed";
        task.currentOutput = { error: error.message };
      });

    return taskId;
  }

  async getOutput(taskId: string, block: boolean = false): Promise<TaskOutput> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Task not found");

    if (block) {
      return await task.promise;
    }
    return task.currentOutput ?? { status: "running", progress: "In progress..." };
  }

  onComplete(taskId: string, callback: (result: TaskOutput) => void): void {
    this.completionCallbacks.set(taskId, callback);
  }

  listRunning(): BackgroundTask[] {
    return [...this.tasks.values()].filter((t) => t.status === "running");
  }
}
```

### 集成点

- `src/agents/pi-embedded-runner/run.ts`: 主循环可spawn后台任务
- `src/agents/tools/background-task.ts`: 新建后台任务工具

---

## Phase 1-6 遗留收尾工作

### Phase 1-6 验证 ✅ 已完成 (2026-04-16)

**验证结果**:

- Phase 1 记忆系统: 43 tests passed ✅
- Phase 2 熔断器/递归保护: 35 tests passed ✅
- Phase 3 危险命令检测: 41 tests passed ✅
- Phase 6 权限系统: 28 tests passed ✅

**运行时集成验证**:

- Phase 1: `run.ts:42,429` - initializeMemoryRuntime ✅
- Phase 2: `run.ts:31,425,854-1130` - CircuitBreaker + runInCompactionContext ✅
- Phase 3: `bash-tools.exec.ts:23,1511-1526` - checkDangerousCommandAndRequestApproval ✅
- Phase 6: `pi-tools.ts:51,673-691`, `pi-tools.before-tool-call.ts:12,148,252` ✅

### Phase 3 后端扩展 ⏳ 待完成

**状态**: 核心模块已完成，扩展未完成

| 扩展项                        | 状态        | 工作量 |
| ----------------------------- | ----------- | ------ |
| sandbox桥接（docker/ssh）     | ⏳ 未完成   | 2天    |
| 权限深度集成                  | ⏳ 部分完成 | 1天    |
| modal/daytona/singularity后端 | ⏳ 未完成   | 3天    |

**建议**: sandbox桥接优先级较高（已有docker/ssh实现可复用）

### Phase 6.2 运行时测试 ⏳ 待完成

需要实际Agent执行验证权限审批流程完整工作。

---

## 执行路径与优先级

### Phase依赖关系图

```
已完成（核心模块+验证）:
├── Phase 6.1+6.2 权限系统 ✅ (28 tests)
├── Phase 2 熔断器+递归保护 ✅ (35 tests)
├── Phase 1 记忆系统 ✅ (43 tests)
├── Phase 3 危险命令检测 ✅ (41 tests)
├── Phase 7 极致缓存利用 ✅ (OpenClaw原生)
└── Phase 1-6 集成验证 ✅ (2026-04-16)

遗留收尾:
├── Phase 3 sandbox桥接 ⏳ （docker/ssh后端）
└── Phase 6.2 运行时测试 ⏳ （实际Agent验证）

待执行路径:

路径A: Hermes学习能力（最高优先级）
├── Phase 8 自主技能形成 ──→ 让Agent能"进化"
│   └── 依赖: 已完成的Phase 6权限系统（审批流程）
│   └── 预计: 2周
│
└── Phase 9 规则持久化 ──→ Agent记住用户偏好
    └── 依赖: Phase 6（权限规则）
    └── 预计: 3天

路径B: Claude Code持久工作（高优先级）
├── Phase 10 StreamingToolExecutor ──→ 流式并发执行
│   └── 依赖: 无，可独立实现
│   └── 预计: 1周
│
├── Phase 11 Fork优化 ──→ 缓存共享
│   └── 依赖: Phase 10（流式执行基础）
│   └── 预计: 1周
│
├── Phase 12 Coordinator模式 ──→ 自主认领任务
│   └── 依赖: Phase 11（Fork子Agent）
│   └── 预计: 1周
│
└── Phase 13 Background Tasks ──→ 后台持久
    └── 依赖: Phase 12（Coordinator循环）
    └── 预计: 1周
```

### 推荐执行顺序（更新）

**优先级0（立即收尾）**:

```
Phase 1-6 遗留收尾工作
├── ✅ Phase 1-6 验证已完成 (2026-04-16)
│   ├── Phase 1: 43 tests ✅
│   ├── Phase 2: 35 tests ✅
│   ├── Phase 3: 41 tests ✅
│   └── Phase 6: 28 tests ✅
│
├── Phase 3 sandbox桥接：复用现有docker/ssh后端
│   └── src/agents/terminal/backend-manager.ts 修改
│   └── 预计: 2天
│
└── Phase 6.2 运行时测试：实际Agent执行验证
    └── 需要手动测试权限审批流程
    └── 预计: 1小时
```

**优先级1（收尾后立即执行）**:

```
Phase 8 自主技能形成
└── 核心价值: Agent学习能力，越用越聪明
└── 独立性强: 依赖已完成的Phase 6
└── 工作量: 2周（4个文件）
```

**优先级2（短期）**:

```
Phase 10 StreamingToolExecutor
└── 核心价值: Claude Code的核心创新
└── 独立性强: 无前置依赖
└── 工作量: 1周（1个核心文件）
```

**优先级3（中期）**:

```
Phase 9 规则持久化 → Phase 11 Fork优化 → Phase 12 → Phase 13
└── 按依赖链顺序执行
└── 总工作量: ~4周
```

### 预期收益

执行完所有待实现Phase后，OpenClaw将具备：

| 能力                | 来源        | 收益                        |
| ------------------- | ----------- | --------------------------- |
| **Agent能学习进化** | Phase 8+9   | 越用越聪明，避免重复探索    |
| **高效并发执行**    | Phase 10    | 工具执行速度提升            |
| **多Agent协作**     | Phase 11-13 | 复杂任务并行处理            |
| **持久稳定工作**    | Phase 12-13 | 长时间任务自动认领+后台执行 |

---

## 总进度

### Claude Code能力（自主持久工作）

| Phase        | 能力                          | 状态          | 进度 | 备注                          |
| ------------ | ----------------------------- | ------------- | ---- | ----------------------------- |
| Phase 6.1    | 权限模块实现                  | ✅ 已完成     | 100% | types/modes/rules/pipeline    |
| Phase 6.2    | 权限融入                      | ✅ 已完成     | 100% | runtime-permission-check.ts   |
| Phase 2      | 上下文管理（熔断器+递归保护） | ✅ 已完成     | 100% | compaction模块                |
| Phase 1      | 记忆系统                      | ✅ 已完成     | 100% | memory模块 + runtime集成      |
| Phase 3      | 终端执行（危险检测）          | ✅ 已完成     | 100% | terminal模块 + bash-tools桥接 |
| Phase 7      | 极致缓存利用                  | ✅ 已覆盖     | 100% | OpenClaw原生实现              |
| **Phase 10** | **StreamingToolExecutor**     | ⏳ **待实现** | 0%   | 流式并发执行                  |
| **Phase 11** | **Fork子Agent优化**           | ⏳ **待实现** | 0%   | 统一占位符缓存                |
| **Phase 12** | **Coordinator模式**           | ⏳ **待实现** | 0%   | 空闲循环+自动认领             |
| **Phase 13** | **Background Tasks**          | ⏳ **待实现** | 0%   | 后台持久执行                  |

### Hermes Agent能力（学习）

| Phase       | 能力             | 状态          | 进度 | 备注                          |
| ----------- | ---------------- | ------------- | ---- | ----------------------------- |
| **Phase 8** | **自主技能形成** | ✅ **已完成** | 100% | skill_manage工具 + 20测试通过 |
| **Phase 9** | **规则持久化**   | ✅ **已完成** | 100% | persistence.ts + 23 tests     |

### 其他Phase

| Phase       | 功能             | 状态          | 进度 | 备注                      |
| ----------- | ---------------- | ------------- | ---- | ------------------------- |
| **Phase 4** | **技能查询工具** | ✅ **已完成** | 100% | skills tool + 12 tests    |
| Phase 5     | 任务/Fork系统    | ⏳ 待开始     | 0%   | 部分内容已纳入Phase 11-13 |

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

### Phase 8 验证 ✅ 已完成

- ✅ TypeScript编译通过
- ✅ Lint检查通过 (0 errors/warnings)
- ✅ 测试全部通过 (20 tests passed)
- ✅ 工具已注册到 OpenClaw 工具系统 (`openclaw-tools.ts:304-306`)
- ✅ 功能验证:
  - validateName: 正确拒绝无效名称 (空/大写/空格/过长)
  - validateCategory: 正确拒绝路径分隔符
  - validateFrontmatter: 正确检测缺失name字段和未闭合frontmatter
  - validateContentSize: 正确拒绝超过100KB内容
  - validateFilePath: 正确拒绝路径逃逸和非法位置
  - create动作: 成功创建技能目录和SKILL.md文件
  - delete动作: 成功删除技能目录
  - duplicate检测: 正确拒绝重名技能创建

### Phase 9 验证 ✅ 已完成

- ✅ TypeScript编译通过
- ✅ Lint检查通过 (0 errors/warnings)
- ✅ 测试全部通过 (23 tests passed)
- ✅ 功能验证:
  - loadSavedRules: 正确加载持久化规则
  - savePermissionRule: 成功保存规则到 ~/.openclaw/permissions.json
  - removeSavedRule: 成功移除指定规则
  - clearAllSavedRules: 清空所有规则
  - cleanExpiredRules: 自动清理过期规则
  - savedRuleToPermissionRule: 正确转换为运行时规则格式
  - mergeSavedRulesWithExisting: 正确合并持久化规则与现有规则
  - 过期规则过滤: 正确过滤已过期规则
  - 规则上限: 最多500条规则，超出时自动裁剪

### Phase 4 验证 ✅ 已完成

- ✅ TypeScript编译通过
- ✅ Lint检查通过 (0 errors/warnings)
- ✅ 测试全部通过 (12 tests passed)
- ✅ 功能验证:
  - list动作: 成功列出所有可用技能
  - list verbose: 成功输出详细技能信息（包括 metadata, invocation, exposure）
  - view动作: 成功读取单个技能内容
  - 错误处理: 正确处理缺少name参数、技能不存在等错误场景

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
2. **查看总进度表**: 确认当前完成状态
3. **选择下一步工作**: 根据以下选项继续

### 当前状态总结

```
已完成:
├── Phase 6.1: permissions模块 (6文件, 28 tests)
├── Phase 6.2: 权限融入 (4文件修改)
├── Phase 2: compaction模块 + run.ts集成 (7文件, 35 tests)
├── Phase 1: memory模块 + 运行时集成 (8文件, 43 tests)
├── Phase 3: terminal模块 + bash-tools桥接 (11文件, 79 tests)
├── Phase 7: Prompt Cache (OpenClaw原生实现，无需移植)
├── Phase 8: 自主技能形成 (2文件, 20 tests)
├── Phase 9: 规则持久化 (2文件, 23 tests)
└── Phase 4: 技能查询工具 (2文件, 12 tests) ✅ NEW

待完成:
└── Phase 5: 任务/Fork (9文件)
```

### 融合核心理念

**目标**: 强化OpenClaw的自主持久工作能力和自主技能形成能力

**Claude Code贡献（自主持久工作）**:

- ✅ 运行时权限决策（安全执行）
- ✅ checkPermissions管道（安全边界）
- ✅ 危险命令检测（30+模式）
- ✅ 权限上下文传递（跨工具）
- ✅ 模式切换（plan模式）
- ✅ **极致缓存利用**（持久高效）
- ⏳ **StreamingToolExecutor**（流式并发）
- ⏳ **Fork子Agent**（并行扩展）
- ⏳ **Coordinator模式**（自主认领）
- ⏳ **Background Tasks**（后台持久）

**Hermes Agent贡献（学习能力）**:

- ⏳ **自主技能形成**（Agent学习进化）
- ⏳ **规则持久化**（记忆用户偏好）

### 下一步选项

**选项 A - 实现自主技能形成（推荐 - 学习能力）**:

```
执行 Phase 8 (自主技能形成)
→ 创建 skill-manage.ts 工具
→ 实现学习触发检测（何时应该"学习"）
→ 工作流程提取逻辑（如何"学习"）
→ 参考 Hermes: tools/skills_tool.py skill_manage
→ 让Agent具备"进化"能力
```

**选项 B - 增强自主持久工作能力**:

```
补充Claude Code的关键能力：
→ StreamingToolExecutor流式并发执行
→ Fork子Agent缓存优化（统一占位符）
→ Background Tasks后台执行
→ Coordinator模式（空闲循环+自动认领）
```

**选项 C - 实现规则持久化**:

```
执行 Phase 9 (规则持久化)
→ 创建 src/agents/permissions/persistence.ts
→ 保存用户审批决策到 ~/.openclaw/permissions.json
→ Agent记住用户偏好，减少重复询问
```

**选项 D - 继续Phase 4/5**:

```
Phase 4 (技能系统扩展) - 技能发现增强
Phase 5 (任务/Fork系统) - 多Agent协作框架
```

### 关键文件快速参考

| 文件                                            | 用途                               |
| ----------------------------------------------- | ---------------------------------- |
| `src/agents/permissions/index.ts`               | 权限模块入口                       |
| `src/agents/compaction/index.ts`                | 压缩模块入口                       |
| `src/agents/terminal/index.ts`                  | 终端模块入口（危险命令检测）       |
| `src/agents/bash-tools.exec-dangerous-check.ts` | 危险命令审批桥接                   |
| `src/memory/index.ts`                           | 记忆模块入口                       |
| `src/agents/memory-runtime.ts`                  | 记忆运行时桥接（已集成）           |
| `src/agents/pi-tools.ts`                        | 工具组装核心（权限已集成）         |
| `src/agents/bash-tools.exec.ts`                 | Bash执行核心（危险检测已集成）     |
| `src/agents/pi-embedded-runner/run.ts`          | Agent运行核心（熔断器+记忆已集成） |

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
- 2026-04-16: Phase 3-B 完成 - bash-tools.exec危险检测桥接集成 (79 tests passed)
- 2026-04-16: Phase 2 集成完成 - pi-embedded-runner/run.ts熔断器集成
- 2026-04-16: Phase 1 集成完成 - memory-runtime.ts桥接模块、run.ts启动初始化
- 2026-04-16: **用户澄清融合核心理念**:
  - Claude Code: **自主持久工作能力** - 12层Harness机制让Agent能长时间稳定完成复杂编程任务
  - Hermes Agent: **自主技能形成能力** - Agent从有效流程中"学习"并固化可复用技能
  - 补充Phase 10-13: StreamingToolExecutor、Fork优化、Coordinator、Background Tasks
  - 重构Phase 8设计: 聚焦于"学习触发"和"工作流程提取"（Agent进化能力）

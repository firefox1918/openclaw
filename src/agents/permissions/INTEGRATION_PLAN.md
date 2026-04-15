# Phase 6: 权限系统融入方案

## 问题分析

Phase 6 创建的 permissions 模块完全独立，未被任何现有代码调用。
没有融入方案，新能力无法发挥作用。

## 现有架构

OpenClaw 已有两层权限控制：

```
Layer 1: 启动时工具过滤
├── applyToolPolicyPipeline (tool-policy-pipeline.ts)
│   └── 按优先级应用多级策略: profile → providerProfile → global → agent → group
│   └── 输出: 可用工具列表
│
Layer 2: Owner-only 工具限制
├── applyOwnerOnlyToolPolicy (tool-policy.ts)
│   └── 检查 tool.ownerOnly 标记
│   └── 非 owner 发送者禁用这些工具
```

## 新模块能力

```
permissions 模块提供:
├── PermissionMode (default/plan/bypass/dontAsk/auto)
│   └── 模式状态机，影响权限决策行为
│
├── PermissionPipeline (6阶段)
│   ├── validateInput: 输入验证
│   ├── hooks: 自定义钩子
│   ├── ruleMatching: 规则匹配 (allow/deny/ask)
│   ├── mode: 模式决策
│   ├── toolCheck: 工具特定检查
│   └── scopeCheck: 权限范围检查
│
├── PermissionProfile
│   └── 可配置的权限配置集，支持 allow/deny/ask 规则
```

## 融入策略

### 策略选择: 增强 + 新增层

不替换现有系统，而是：

1. **增强 Layer 1**: 在配置解析时支持 PermissionProfile
2. **新增 Layer 3**: 在工具执行前添加运行时权限检查

```
融入后的架构:

Layer 1: 启动时工具过滤 (保持现有)
├── applyToolPolicyPipeline
│   └── [新增] 支持 PermissionProfile 配置源
│   └── 输出: 可用工具列表
│
Layer 2: Owner-only 工具限制 (保持现有)
├── applyOwnerOnlyToolPolicy
│   └── 保持不变
│
Layer 3: 运行时权限检查 (新增)
├── checkRuntimePermission ← 调用 permissions 模块
│   ├── 输入: toolName, input, PermissionContext
│   ├── 处理: executePermissionPipeline
│   └── 输出: allow/ask/deny 决策
```

## 具体融入步骤

### Step 1: 配置层集成

修改 `src/config/types.tools.ts`:

```typescript
// 新增 PermissionProfile 引用
type ToolsConfig = {
  // 现有配置保持不变
  allow?: string[];
  deny?: string[];
  profile?: string;

  // 新增权限配置
  permissionProfile?: string; // 引用 PermissionProfile.id
  permissionMode?: ExternalPermissionMode; // 默认模式
};
```

### Step 2: 工具策略管道集成

修改 `src/agents/tool-policy-pipeline.ts`:

```typescript
import { createPermissionContextFromProfile, PermissionProfile } from "./permissions/index.js";

// 在 buildDefaultToolPolicyPipelineSteps 中添加权限配置步骤
```

### Step 3: 运行时检查集成

在工具执行入口添加检查。核心入口点：

- `src/agents/pi-embedded-runner/run.ts` - Agent 主循环
- `src/agents/tools/*.ts` - 各工具的 execute 方法

创建新文件 `src/agents/runtime-permission-check.ts`:

```typescript
import { checkPermission, PermissionResult, ToolPermissionContext } from "./permissions/index.js";

/**
 * 运行时权限检查 - 在工具执行前调用
 */
export async function checkRuntimePermission(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
): Promise<PermissionResult> {
  return checkPermission(toolName, input, context);
}
```

### Step 4: Agent 运行时集成

修改 `src/agents/pi-embedded-runner/run.ts`:

```typescript
import { checkRuntimePermission } from "../runtime-permission-check.js";
import { createPermissionContextFromConfig } from "../permissions/index.js";

// 在工具执行前
const permissionResult = await checkRuntimePermission(tool.name, toolInput, permissionContext);
if (permissionResult.behavior === "deny") {
  // 返回拒绝消息
  return { type: "error", message: permissionResult.message };
}
if (permissionResult.behavior === "ask") {
  // 触发用户确认流程
  await askUserPermission(permissionResult.message);
}
```

### Step 5: 配置 Schema 添加

修改 `src/config/schema.ts` 或 `src/config/zod-schema.ts`:

```typescript
// 添加 PermissionProfile schema
const PermissionProfileSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  defaultMode: z
    .enum(["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"])
    .optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  bypassPermissionsAvailable: z.boolean().optional(),
  requiredScope: z.array(z.string()).optional(),
});

// 添加到 config schema
const ConfigSchema = z.object({
  // 现有字段...
  permissionProfiles: z.array(PermissionProfileSchema).optional(),
});
```

## 验证计划

融入完成后验证：

1. **配置解析测试**: PermissionProfile 正确加载
2. **工具过滤测试**: 权限配置正确影响可用工具列表
3. **运行时检查测试**:
   - plan 模式下 write 操作触发确认
   - bypass 模式下（有权限）自动允许
   - deny 规则正确拦截
4. **向后兼容测试**: 无 permissionProfile 配置时保持现有行为

## 风险评估

| 风险         | 缓解措施                                 |
| ------------ | ---------------------------------------- |
| 破坏现有行为 | 分层设计，新增 Layer 不修改现有 Layer    |
| 性能影响     | 运行时检查仅在必要工具上执行             |
| 配置迁移成本 | PermissionProfile 可选，无配置时默认行为 |

## 实施优先级

1. Step 3 (runtime-permission-check.ts) - 最高优先级，创建核心集成点
2. Step 4 (pi-embedded-runner/run.ts) - 高优先级，实际调用点
3. Step 1 (types.tools.ts) - 中优先级，配置支持
4. Step 5 (schema.ts) - 中优先级，Schema 定义
5. Step 2 (tool-policy-pipeline.ts) - 低优先级，可选增强

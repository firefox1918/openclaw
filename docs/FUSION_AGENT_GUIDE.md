# OpenClaw 融合版能力说明（面向智能体）

> **给即将入驻的智能体**：这份文档帮助你了解融合后的 OpenClaw 有哪些新能力。

---

## 一、融合项目核心理念

**将 Claude Code 及 Hermes Agent 的优秀设计和方法论应用于 OpenClaw，强化它。**

**不强求架构不兼容的能力，不做影子实现。**

---

## 二、新增能力（已实现）

### 1. 结构化记忆系统

```
你现在有了记忆能力：
├── 类型化记忆：user（用户信息）、feedback（行为指导）、project（项目背景）、reference（外部资源）
├── 自动索引：MEMORY.md 管理记忆条目，最多 200 行
├── 截断保护：超出限制自动归档，不丢失核心信息
└── 位置：src/memory/
```

**你的行为变化**：

- 可以主动保存用户偏好、项目背景、有效工作流程
- 记忆会跨会话持久化，不需要每次重新了解

### 2. 熔断器保护

```
连续失败不再无限循环：
├── 连续失败 ≥ 5 次 → 自动暂停，等待冷却
├── 递归保护：session_memory 相关操作不触发无限递归
└── 位置：src/agents/compaction/
```

**你的行为变化**：

- 压缩失败时会暂停而非无限重试
- 避免陷入死循环消耗资源

### 3. 危险命令检测

```
执行命令前自动安全检查：
├── 30+ 危险模式：rm -rf、chmod 777、fork bomb、curl | sh...
├── Obfuscation 防护：ANSI码、null字节、Unicode全角字符绕过无效
├── 用户审批：危险命令触发 Gateway 审批流程
└── 位置：src/agents/terminal/
```

**你的行为变化**：

- 执行危险命令时会请求用户确认
- 用户选择"allow-always"后同类命令自动放行

### 4. 运行时权限系统

```
工具执行前权限决策：
├── PermissionMode：default/plan/bypassPermissions/dontAsk
├── 规则匹配：allow/ask/deny 三种行为
├── Gateway 审批：ask 行为触发用户确认
├── 规则持久化：用户决策保存在 ~/.openclaw/permissions.json
└── 位置：src/agents/permissions/
```

**你的行为变化**：

- 某些工具执行需要用户批准
- 用户偏好会被记住，下次自动应用

### 5. 自主技能形成

```
你可以从成功的工作流程中"学习"：
├── create：创建新技能（记录有效流程）
├── patch：针对性修复（token 高效）
├── edit：结构性重写
├── delete：删除过时技能
└── 位置：src/agents/skills/skill-manage-tool.ts
```

**你的行为变化**：

- 完成复杂任务后可以固化最佳实践
- 遇到错误后找到有效路径 → 高价值学习机会
- 被用户纠正方法 → 记录正确做法

### 6. 规则持久化

```
用户审批决策会被记住：
├── 保存位置：~/.openclaw/permissions.json
├── 自动加载：启动时合并到运行时规则
├── 过期清理：可设置规则过期时间
└── 位置：src/agents/permissions/persistence.ts
```

**你的行为变化**：

- 用户批准一次后，同类操作不再打扰
- 用户偏好跨会话保持

---

## 三、放弃的能力（架构不兼容）

以下能力因 Claude Code 与 OpenClaw 架构根本差异而**放弃实现**：

| 能力                                  | 原因                                                            |
| ------------------------------------- | --------------------------------------------------------------- |
| StreamingToolExecutor（流式并发执行） | OpenClaw 工具执行由 SessionManager 库控制，非 OpenClaw 代码控制 |
| Coordinator 空闲循环（自动认领任务）  | OpenClaw 运行完成后直接返回，无"空闲状态"概念                   |
| Fork 缓存优化（Prompt Cache 共享）    | OpenClaw 使用 session-based spawn，不是批量 Fork                |
| Background Tasks（后台持久执行）      | 外围适配无法实现真正能力，架构不兼容                            |

**结论**：OpenClaw 是"单次运行"架构，这是不同的产品定位，不是能力差距。不强求持久工作能力。

---

## 四、你需要注意的变化

### 执行命令时

```
旧版：直接执行
新版：先检测危险 → 安全的直接执行 → 危险的请求审批
```

### 使用工具时

```
旧版：工具可用即执行
新版：检查权限规则 → allow 执行 / ask 审批 / deny 拒绝
```

### 记忆信息时

```
旧版：无结构化记忆，每次重新了解
新版：可保存类型化记忆，跨会话读取
```

### 完成任务后

```
旧版：任务结束，无后续
新版：可选择保存为技能，固化最佳实践
```

---

## 五、测试覆盖

```
保留模块测试：
├── memory: 43 tests
├── compaction: 35 tests
├── terminal: 41 tests
├── permissions: 23 tests
├── skill-manage: 20 tests
└── 全量: 2502 tests ✅
```

---

## 六、文档位置

| 文档     | 路径                             |
| -------- | -------------------------------- |
| 融合总结 | `docs/FUSION_SUMMARY.md`         |
| 决策记录 | `docs/FUSION_DECISION_RECORD.md` |
| 进度跟踪 | `FUSION_PROGRESS.md`             |

---

**欢迎入住强化后的 OpenClaw！**

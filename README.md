# Pi Obsidian Live

一个极简的 Pi 扩展：把当前 Pi 会话的最近 N 轮对话，实时镜像到一个 Markdown 文件里，让 Obsidian 成为你的阅读面板。

```text
Pi session / streaming events
          ↓
extract user + assistant content in original order
          ↓
filesystem write (atomic)
          ↓
Pi-Live.md
          ↓
Obsidian renders Markdown
```

核心原则：

- **不解释内容** — assistant 文本本身就是 Markdown，原样搬运（表格、代码块、LaTeX、Mermaid 都原样保留）
- **完整保留模型输出** — thinking、tool call、tool result 都是模型回复的一部分，按原始顺序呈现，用 Obsidian 原生折叠块（callout）收起，点击即可展开
- **单文件滑动窗口** — 只显示最近 N 轮，完整历史仍由 Pi 自己保存
- **只含会话内容** — 系统消息、内部 Pi 消息、元数据不出现

## 安装

```bash
cp obsidian-live.ts ~/.pi/agent/extensions/obsidian-live.ts
```

在 Pi 里执行 `/reload`（或重启 Pi）即可生效。

## 使用

### 命令

| 命令 | 作用 |
|---|---|
| `/oblive <路径>` | 手动启用，默认 `turns = 1` |
| `/oblive <n>` | 修改滑动窗口大小（正整数） |
| `/oblive status` | 查看当前状态 |
| `/oblive off` | 停止写入（不删除已有文件） |

### 自动启用（默认开启）

每次会话启动自动启用，默认写入 `DEFAULT_LIVE_DIR`（见 `obsidian-live.ts` 顶部常量），文件名自动生成：

```text
Pi-Live-<项目目录名>-<时间戳>.md
```

并行运行多个 agent 时互不冲突（同一秒启动自动加 `-2` 后缀）。

### 本机配置（推荐）

扩展会在会话启动时读取可选的本机配置文件 `~/.pi/agent/oblive.json`（不进仓库）：

```json
{
  "liveDir": "/path/to/vault/Notes",
  "livePath": "/path/to/exact-file.md",
  "turns": 3,
  "autoEnable": false,
  "template": false
}
```

| 字段 | 作用 |
|---|---|
| `liveDir` | 自动命名文件的默认目录 |
| `livePath` | 默认精确目标文件 |
| `turns` | 默认窗口大小 |
| `autoEnable` | `false` 时完全关闭自动启用 |
| `template` | `false` 时文件不带 YAML frontmatter，正文直接从 `## Me` 开始（默认 `true`） |

缺失文件、JSON 损坏或字段非法时优雅降级（通知后使用默认值），不会报错崩溃。

### 环境变量（单次启动覆盖，优先级最高）

| 变量 | 作用 |
|---|---|
| `OBLIVE_OFF=1` | 本次启动完全关闭自动启用 |
| `OBLIVE_PATH=<文件>` | 本次指定精确目标文件 |
| `OBLIVE_DIR=<目录>` | 本次换一个目录（自动命名） |
| `OBLIVE_TURNS=<n>` | 本次初始窗口大小 |
| `OBLIVE_TEMPLATE=0/1` | 本次关闭/开启 YAML frontmatter |

优先级：环境变量 > 配置文件 > 内置默认。

示例：

```bash
OBLIVE_DIR=~/Documents/Obsidian/Pi-Live pi          # 临时换目录
OBLIVE_PATH=~/vault/backend.md pi                   # 临时精确文件
OBLIVE_OFF=1 pi                                     # 临时关掉
OBLIVE_TURNS=3 pi                                   # 临时显示最近 3 轮
```

## 文件格式

每个生成的文件带统一的 YAML frontmatter（可被 Obsidian Properties / Dataview 索引）：

```yaml
---
type: pi-live
project: "project-name"
session: "session-uuid"
model: "provider/model-id"
turns: 3
created: "2026-08-19T16:30:00+08:00"
updated: "2026-08-19T16:31:05+08:00"
tags:
  - pi-live
  - project-name
---
```

正文结构（一轮 turn = 一次用户 prompt + 该次 agent run 的全部模型输出，按原始顺序）：

```markdown
## Me

<用户 prompt 原文>

## Pi

<assistant Markdown 原文>

> [!note]- Thinking
> <模型的 thinking，原文；点击左侧箭头展开/收起>

> [!info]- Tool: bash
> ```json
> {
>   "command": "ls -la"
> }
> ```

> [!quote]- Tool result: bash
> ```text
> <工具输出，超长自动截断>
> ```

<继续下一段 assistant Markdown>
```

折叠块说明：

- Obsidian 原生 callout（`-` 后缀 = 默认折叠），阅读模式和实时预览都能点击展开/收起
- Thinking → `[!note]-`；Tool call → `[!info]-`（参数为 json 代码块）；Tool result → `[!quote]-`（错误为 `[!warning]-`，输出为 text 代码块）
- 想默认展开：把 `obsidian-live.ts` 里 `callout()` 的 `]-` 改成 `]`
- 工具输出超过 300 行 / 50KB 时截断并标注（thinking 和 assistant 文本永不截断）

## 设计要点

- **轮次边界**：`agent_settled`（agent run 完全结束，不会再有自动重试/压缩/后续消息）
- **流式捕获**：`before_agent_start` 拿用户 prompt；`message_start` / `message_update` / `message_end` 拿 assistant 流式内容（text / thinking / toolCall 块按序重建）
- **历史重建**：`ctx.sessionManager.getBranch()` 只走当前活跃分支（root → leaf），天然排除被放弃的兄弟分支
- **写入策略**：流式期间约 300ms 去抖 + 临时文件 rename 原子替换（Obsidian 不会读到半截文件）
- **配置**：本机配置 `~/.pi/agent/oblive.json` + 环境变量覆盖 + `/oblive` 命令；全部内存态，重启后自动按配置重新启用

## 许可

MIT

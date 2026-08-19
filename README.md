# Pi Obsidian Live

一个极简的 Pi 扩展：把当前 Pi 会话的最近 N 轮对话，实时镜像到一个 Markdown 文件里，让 Obsidian 成为你的阅读面板。

```text
Pi session / streaming events
          ↓
extract existing user + assistant text
          ↓
filesystem write (atomic)
          ↓
Pi-Live.md
          ↓
Obsidian renders Markdown
```

核心原则：

- **不解释内容** — assistant 文本本身就是 Markdown，原样搬运（表格、代码块、LaTeX、Mermaid 都原样保留）
- **单文件滑动窗口** — 只显示最近 N 轮，完整历史仍由 Pi 自己保存
- **只含人读内容** — 过滤 thinking、tool call、tool result、系统消息、元数据

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

每次会话启动自动启用，默认写入 `DEFAULT_LIVE_DIR`（见 `obsidian-live.ts` 顶部常量，按需修改），文件名自动生成：

```text
Pi-Live-<项目目录名>-<时间戳>.md
```

并行运行多个 agent 时互不冲突（同一秒启动自动加 `-2` 后缀）。

环境变量控制：

| 变量 | 作用 |
|---|---|
| `OBLIVE_OFF=1` | 完全关闭自动启用 |
| `OBLIVE_PATH=<文件>` | 指定精确目标文件 |
| `OBLIVE_DIR=<目录>` | 换一个目录（自动命名） |
| `OBLIVE_TURNS=<n>` | 初始窗口大小（默认 1） |

示例：

```bash
OBLIVE_DIR=~/Documents/Obsidian/Pi-Live pi          # 换目录
OBLIVE_PATH=~/vault/backend.md pi                   # 精确文件
OBLIVE_OFF=1 pi                                     # 关掉
OBLIVE_TURNS=3 pi                                   # 显示最近 3 轮
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

正文结构：

```markdown
## Me

<用户 prompt 原文>

## Pi

<assistant Markdown 原文>
```

一轮（turn）= 一次用户 prompt + 该次 agent run 产生的全部 assistant 文本（中间穿插的 tool call / tool result 不出现）。

## 设计要点

- **轮次边界**：`agent_settled`（agent run 完全结束，不会再有自动重试/压缩/后续消息）
- **流式捕获**：`before_agent_start` 拿用户 prompt；`message_start` / `message_update` / `message_end` 拿 assistant 流式文本（只取 `type: "text"` 块）
- **历史重建**：`ctx.sessionManager.getBranch()` 只走当前活跃分支（root → leaf），天然排除被放弃的兄弟分支
- **写入策略**：流式期间约 300ms 去抖 + 临时文件 rename 原子替换（Obsidian 不会读到半截文件）
- **配置不持久化**：V1 全部在内存里，重启后按环境变量/命令重新启用

## 许可

MIT

# Pi Obsidian Live

A tiny [Pi](https://github.com/earendil-works/pi-mono) extension that live-mirrors
the latest N turns of the current Pi conversation into a single Markdown file, so
Obsidian becomes your reading surface for long responses.

```text
Pi session / streaming events
          ↓
extract user + assistant content in original order
          ↓
atomic filesystem write (temp file + rename)
          ↓
Pi-Live.md
          ↓
Obsidian renders Markdown
```

## Principles

- **No interpretation.** Assistant text is already Markdown — it is transported
  verbatim (tables, code blocks, LaTeX, Mermaid, blockquotes, …).
- **Full model output, in order.** Thinking, tool calls, and tool results are part
  of the model's response. They are preserved in their original order and folded
  away with Obsidian-native callouts (one click to expand).
- **A sliding window, not a duplicate database.** Only the latest N turns are
  shown; Pi keeps the full history. Nothing is re-stored.
- **Conversation content only.** System messages, internal Pi messages, and
  metadata never appear.

## Installation

```bash
cp obsidian-live.ts ~/.pi/agent/extensions/obsidian-live.ts
```

Then run `/reload` in Pi (or restart Pi).

## Commands

| Command | Effect |
|---|---|
| `/oblive <path>` | Enable live view at this file (defaults to `turns = 1`) |
| `/oblive <n>` | Change the sliding-window size (positive integer) |
| `/oblive status` | Show whether live view is on, the path, and the turn count |
| `/oblive off` | Stop writing updates (the existing file is kept) |

## Auto-enable

By default the extension enables itself when a session starts and writes to the
configured default directory with an auto-generated name:

```text
Pi-Live-<project-directory>-<timestamp>.md
```

Parallel agents never collide: if a name is already taken (e.g. two agents start
in the same second), the next file gets a `-2`, `-3`, … suffix.

## Configuration

### Machine-local config file (recommended)

On session start the extension reads an optional local config file that is **not
meant to be committed** to a repository:

`~/.pi/agent/oblive.json`

```json
{
  "liveDir": "/path/to/vault/Notes",
  "livePath": "/path/to/exact-file.md",
  "turns": 3,
  "autoEnable": false,
  "template": false
}
```

| Field | Meaning |
|---|---|
| `liveDir` | Default directory for auto-generated file names |
| `livePath` | Default exact target file (takes precedence over `liveDir`) |
| `turns` | Default sliding-window size (default `1`) |
| `autoEnable` | `false` disables auto-enable entirely |
| `template` | `false` omits the YAML frontmatter block (default `true`) |

A missing file, malformed JSON, or invalid fields degrade gracefully: the
extension notifies once and falls back to defaults — it never crashes.

### Environment variables (per-launch overrides)

| Variable | Effect |
|---|---|
| `OBLIVE_OFF=1` | Disable auto-enable for this launch |
| `OBLIVE_PATH=<file>` | Use this exact file for this launch |
| `OBLIVE_DIR=<dir>` | Use this directory (auto-generated name) for this launch |
| `OBLIVE_TURNS=<n>` | Initial window size for this launch |
| `OBLIVE_TEMPLATE=0/1` | Disable/enable the YAML frontmatter for this launch |

Resolution order: **environment variables → config file → built-in default.**

```bash
OBLIVE_DIR=~/Documents/Obsidian/Pi-Live pi   # one-off directory
OBLIVE_PATH=~/vault/backend.md pi            # one-off exact file
OBLIVE_OFF=1 pi                              # one-off disable
OBLIVE_TURNS=3 pi                            # one-off window size
```

## File format

With the template enabled (the default), every file starts with a uniform YAML
frontmatter block, indexable by Obsidian Properties and Dataview:

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

The body is a plain role-boundary structure. One **turn** = one user prompt plus
all model output produced in response until the agent run settles:

```markdown
## Me

<user prompt, verbatim>

## Pi

<assistant Markdown, verbatim>

> [!note]- Thinking
> <model thinking, verbatim>

> [!info]- Tool: bash
> ```json
> {
>   "command": "ls -la"
> }
> ```

> [!quote]- Tool result: bash
> ```text
> <tool output, truncated if huge>
> ```

<next chunk of assistant Markdown>
```

### Folding

Obsidian callouts with the `-` suffix render collapsed by default and stay
foldable in both reading and live-preview modes:

| Content | Callout |
|---|---|
| Thinking | `> [!note]-` |
| Tool call | `> [!info]-` (arguments as a JSON code block) |
| Tool result | `> [!quote]-` (`> [!warning]-` on error; output as a text code block) |

To render callouts expanded by default, change `]-` to `]` in the `callout()`
function in `obsidian-live.ts`.

Tool output is truncated beyond 300 lines / 50 KB with an explicit marker;
thinking and assistant text are never truncated.

## Design notes

| Concern | Approach |
|---|---|
| Turn boundary | `agent_settled` — fires only when no auto-retry, compaction, or queued follow-up will run |
| User prompt | Captured from `before_agent_start` (`event.prompt`) |
| Streaming | `message_start` / `message_update` / `message_end`; the in-progress assistant message is rebuilt from its `text` / `thinking` / `toolCall` content blocks in order |
| History | `ctx.sessionManager.getBranch()` walks the active branch only (root → leaf), so abandoned sibling branches never leak in |
| Writes | ~300 ms debounce while streaming, then an atomic temp-file + rename (Obsidian never reads a half-written file) |
| State | In-memory only; after `/reload`, `/new`, or a restart the extension re-enables from the config file |

## License

MIT

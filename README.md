# Pi Obsidian Live

A [Pi](https://github.com/earendil-works/pi-mono) package with two deliberately
separate features:

- **Live view** mirrors the latest N turns into generated Markdown for Obsidian.
- **Memory** optionally manages isolated Learning Spaces outside the Obsidian
  vault and recalls accepted memories in later sessions.

Obsidian is the reading surface. The configurable `dataRoot` is the memory
store. Pi session custom entries persist only the selected Space and memory
mode for the current session.

## Inspiration

This project is a Pi-extension remake of the workflow from the video
[**"How I Use AI to Learn Things"**](https://www.youtube.com/watch?v=kzcI5F4tGiU&t=752s)
by **Eero Alvar** — streaming an AI conversation into a Markdown file that
Obsidian renders as a live reading surface.

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
- **The live view is a projection, not a note database.** Only the latest N
  turns are shown in generated Markdown. It is safe to overwrite or clean up.
- **Conversation content only.** System messages, internal Pi messages, and
  metadata never appear.
- **Memory is opt-in and isolated.** Only accepted memory records from the
  session's mounted Learning Space can be recalled. Thinking, tool calls, tool
  results, and credential-shaped values are excluded from extraction.

## Installation

Install this directory as a local Pi package:

```bash
pi install /Users/jimmy/coding/pi-obsidian-live
```

For a global install from a published package or Git repository, use the
corresponding `npm:` or `git:` source. Then run `/reload` in Pi (or restart Pi).

The old `~/.pi/agent/oblive.json` and `OBLIVE_*` configuration remain
compatible. The package entry point is still `obsidian-live.ts`, so existing
`/oblive` behavior is preserved.

## Commands

| Command | Effect |
|---|---|
| `/oblive <path>` | Enable live view at this file (defaults to `turns = 1`) |
| `/oblive <n>` | Change the sliding-window size (positive integer) |
| `/oblive status` | Show whether live view is on, the path, and the turn count |
| `/oblive off` | Stop writing updates (the existing file is kept) |
| `/oblive <flag> [on\|off]` | Toggle or set a flag: `repair`, `thinking`, `tools`, `template`. No value flips the current state. |
| `/space list` | List registered Learning Spaces |
| `/space new <name> [path]` | Create a Space under `dataRoot`, or at an explicit path |
| `/space use <name>` | Mount one Space in this Pi session |
| `/space off` | Unmount the Space in this Pi session |
| `/space status` | Show the session's mounted Space and data root |
| `/memory status` | Show memory mode, mounted Space, pending jobs, and backend |
| `/memory off` | Disable recall and generation for this session |
| `/memory read` | Enable recall without generation |
| `/memory on` | Enable recall and candidate generation (`read-write`) |
| `/memory capture` | Queue and process the current visible turn as candidates |
| `/memory review` | List candidate files waiting in the Space inbox |
| `/memory accept <id>` | Promote one candidate to accepted memory |
| `/memory reject <id> [reason]` | Move one candidate to the Space rejected archive |

Accepted boolean values for the toggle: `on`, `off`, `true`, `false`, `1`, `0` (case-insensitive). If the first token of the argument matches a flag name but the value is invalid, the command notifies an error rather than silently treating it as a path.

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
  "template": false,
  "thinking": false,
  "tools": false,
  "repair": false
}
```

| Field | Meaning |
|---|---|
| `liveDir` | Default directory for auto-generated file names |
| `livePath` | Default exact target file (takes precedence over `liveDir`) |
| `turns` | Default sliding-window size (default `1`) |
| `autoEnable` | `false` disables auto-enable entirely |
| `template` | `false` omits the YAML frontmatter block (default `true`) |
| `thinking` | `false` omits thinking callouts (default `true`) |
| `tools` | `false` omits both tool call and tool result callouts (default `true`) |
| `repair` | `false` skips cascade-protection fence balancing at the end of a run (default `true`) |

Reading-only use cases (for example, using Pi as a tutor, where thinking and
tool activity are noise) typically set `template`, `thinking`, and `tools` all to
`false` to get a plain `## Me` / `## Pi` transcript.

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
| `OBLIVE_THINKING=0/1` | Disable/enable thinking callouts for this launch |
| `OBLIVE_TOOLS=0/1` | Disable/enable tool call / tool result callouts for this launch |
| `OBLIVE_REPAIR=0/1` | Disable/enable cascade-protection fence balancing for this launch |

Resolution order: **environment variables → config file → built-in default.**

```bash
OBLIVE_DIR=~/Documents/Obsidian/Pi-Live pi   # one-off directory
OBLIVE_PATH=~/vault/backend.md pi            # one-off exact file
OBLIVE_OFF=1 pi                              # one-off disable
OBLIVE_TURNS=3 pi                            # one-off window size
```

## Learning Spaces and memory configuration

Memory is independent from `/oblive`. Turning memory off does not stop the
Obsidian live view. Add an optional `~/.pi/agent/pi-live.json`:

```json
{
  "dataRoot": "~/.pi/agent/pi-live-data",
  "memory": {
    "mode": "off",
    "autoCapture": true,
    "captureIdleMs": 120000,
    "minTextChars": 80,
    "retrievalLimit": 5,
    "maxPromptChars": 6000,
    "jobLeaseMs": 90000,
    "maxJobAttempts": 3,
    "shutdownTimeoutMs": 1500
  }
}
```

`PILIVE_DATA_ROOT` and `PILIVE_MEMORY_MODE` (`off`, `read`, `read-write`, or
`on`) are optional launch-time overrides. The default data root is:

```text
~/.pi/agent/pi-live-data/
├── registry.json
└── spaces/<space-id>/
    ├── inbox/       # generated candidates, not recalled by default
    ├── rejected/    # explicitly rejected candidates with provenance
    ├── memories/    # accepted memory records used for recall
    ├── jobs/        # durable extraction queue and retry state
    └── index/       # derived retrieval metadata
```

`/space new <name>` creates a Space at `dataRoot/spaces/<id>`. Space names keep
Unicode letters such as Chinese readable while removing path separators and
other unsafe characters. Supplying a path uses that location instead, which is
useful for placing memory data in a private directory separate from an
Obsidian vault. Space paths are registered in `registry.json`; the selected
Space itself is stored in the active Pi session branch with `appendEntry`, not
in a process-global variable.

There is no automatic user-note feature. Generated live views remain in the
configured Obsidian `liveDir`/`livePath`; the package never creates ordinary
Obsidian notes.

### Memory lifecycle

```text
agent_settled
    ↓ visible user + assistant text only
durable job in Space/jobs
    ↓ conservative idle/debounce window (default 2 minutes)
ctx.modelRegistry.complete() (no sub-agent or extra Pi session)
candidate in Space/inbox
    ↓ /memory accept <id>
accepted record in Space/memories
    ↓ next before_agent_start
bounded lexical recall for the mounted Space only
```

Automatic extraction can be disabled with `autoCapture: false`; `/memory capture`
still runs immediately. Jobs use an expiring cross-process lease,
heartbeat renewal, exponential retry delay, and a maximum attempt count.
Shutdown aborts the request and waits only for the configured bounded timeout;
an unfinished lease is recovered later as stale. Candidates are never injected
into context until explicitly accepted. V1 intentionally implements only a
deterministic local lexical backend behind a retrieval interface. Hybrid/vector
retrieval (including LanceDB) is not implemented yet and is not required for
the current fallback.

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

### Hiding callouts entirely

If thinking and tool activity are noise for your reading workflow (for example
when using Pi purely as a tutor), set `thinking: false` and/or `tools: false`
in the config file. The corresponding blocks are then omitted from the file
entirely — not even the callout label remains — leaving a clean
`## Me` / `## Pi` transcript. The same toggles are available at runtime via
`/oblive thinking on|off` and `/oblive tools on|off`.

### Cascade protection

A single unclosed fenced code block in the model's output is the most common
cause of a whole-file rendering failure in Obsidian (everything after the
unclosed ``` renders as code). At the end of every run, `agent_settled`
counts the triple-backtick fence lines in the rendered body; if the count is
odd, one closing fence is appended. This is mechanical delimiter balancing —
it never modifies model content and adds at most one line. Streaming writes
do not perform this repair (it would clash with the model's own closing
fence), so partial in-flight code blocks render as-is and normalize at the
end of the run. Disable with `repair: false` in the config, `OBLIVE_REPAIR=0`
per launch, or `/oblive repair off` at runtime.

## Design notes

| Concern | Approach |
|---|---|
| Turn boundary | `agent_settled` — fires only when no auto-retry, compaction, or queued follow-up will run |
| User prompt | Captured from `before_agent_start` (`event.prompt`) |
| Streaming | `message_start` / `message_update` / `message_end`; the in-progress assistant message is rebuilt from its `text` / `thinking` / `toolCall` content blocks in order |
| History | `ctx.sessionManager.getBranch()` walks the active branch only (root → leaf), so abandoned sibling branches never leak in |
| Writes | ~300 ms debounce while streaming, then an atomic temp-file + rename (Obsidian never reads a half-written file) |
| Live state | In-memory and session-local; after `/reload`, `/new`, or a restart the live view re-enables from the existing `oblive.json` configuration |
| Space state | Session custom entries on the active branch; `/space use` and `/space off` survive resume/fork/tree navigation correctly |
| Memory state | JSON records and durable jobs under the configured data root; accepted records are the only recall source |
| Background work | Idle/debounce scheduling, expiring leases, bounded retries, abortable model requests, and bounded shutdown wait |
| Retrieval | Deterministic lexical backend behind an extension point; hybrid/vector retrieval is explicitly not implemented in V1 |

## License

MIT

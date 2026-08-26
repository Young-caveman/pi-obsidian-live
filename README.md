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

Hybrid retrieval is an optional runtime enhancement. The package itself has no
mandatory vector/native dependency, so a fresh install works with BM25. Two
optional embedding providers are available: the local open-source provider
(install the peer in the package directory):

```bash
npm install @huggingface/transformers
```

or the hosted OpenRouter embeddings API, which only needs an API key (see
"Remote embeddings via OpenRouter" below).

The old `~/.pi/agent/oblive.json` and `OBLIVE_*` configuration remain
compatible. The package entry point is still `obsidian-live.ts`, so existing
`/oblive` behavior is preserved.

## Commands

The package registers three slash commands — `/oblive`, `/space`, and `/memory` —
all from the same extension. After installing the package and restarting Pi (or
`/reload`), every command below is recognized. Memory behavior itself stays
opt-in: recall/generation only start once the session memory mode and a
mounted Space allow them (see the mode table under `/memory`).

### Live view: `/oblive`

| Command | Effect |
|---|---|
| `/oblive <path>` | Enable live view at this file (defaults to `turns = 1`) |
| `/oblive <n>` | Change the sliding-window size (positive integer) |
| `/oblive status` | Show whether live view is on, the path, and the turn count |
| `/oblive off` | Stop writing updates (the existing file is kept) |
| `/oblive <flag> [on\|off]` | Toggle or set a flag: `repair`, `thinking`, `tools`, `template`. No value flips the current state. |

Always usable; needs no configuration to answer, though auto-enable itself can
be disabled via config/env (`autoEnable: false`, `OBLIVE_OFF=1`).

Accepted boolean values for the toggle: `on`, `off`, `true`, `false`, `1`, `0`
(case-insensitive). If the first token of the argument matches a flag name but
the value is invalid, the command notifies an error rather than silently
treating it as a path.

### Spaces: `/space`

| Command | Effect |
|---|---|
| `/space list` | List registered Learning Spaces with accepted-memory counts |
| `/space new <name> [path]` | Create a Space under `dataRoot`, or at an explicit path |
| `/space use <name>` | Mount one Space in this Pi session |
| `/space off` | Unmount the Space in this Pi session |
| `/space status` | Show the session's mounted Space, data root, and memory counts |

Always usable. Needs no pre-configuration: the first command creates
`dataRoot` and `registry.json` on demand. The selected Space is stored in the
session branch, so it survives resume/fork/tree navigation.

### Memory: `/memory`

| Command | Effect |
|---|---|
| `/memory status` | Show memory mode, mounted Space, memory counts, pending jobs, and backend |
| `/memory off` | Disable recall and generation for this session |
| `/memory read` | Enable recall without generation |
| `/memory on` | Enable recall and candidate generation (`read-write`) |
| `/memory capture` | Queue and process the current visible turn as candidates |
| `/memory review` | List candidate files waiting in the Space inbox |
| `/memory accept <id> [more ids...]` | Promote one or more candidates to accepted memory |
| `/memory reject <id> [reason]` | Move one candidate to the Space rejected archive |

**Prerequisites per subcommand** (violations notify an error, never crash):

| Subcommand | Needs session mode | Needs a mounted Space |
|---|---|---|
| `status` | any | no |
| `off` / `read` / `on` | any | no |
| `capture` | `read-write` | yes |
| `review` | any | yes |
| `accept <id>` / `reject <id> [reason]` | any | yes (candidate must exist there) |

**Memory modes** decide what happens automatically during agent turns:

| Mode | Recall into prompts | Generate candidates |
|---|---|---|
| `off` (default) | never | never |
| `read` | yes | no (manual `capture` also blocked) |
| `read-write` (`on`) | yes | yes (auto after idle window, and via `capture`) |

Mode is session-local (`/memory on` needed again after a restart, unless
`PILIVE_MEMORY_MODE` or the config file sets one). Recall also needs at least
one accepted memory in the mounted Space; generation needs `autoCapture`
(which `capture` bypasses) and a visible turn shorter than `minTextChars` is
skipped.

**Why review exists.** Extraction is deliberately conservative but not
infallible. Candidates never enter recall context until `/memory accept`
moves them to accepted memory — an operator gate that keeps transient chat
garbage and model guesses out of long-term memory. Two opt-in shortcuts keep
the gate without losing it: `accept` takes multiple ids in one command, and
setting `memory.autoAcceptMinConfidence` (e.g. `0.9`) or
`PILIVE_AUTO_ACCEPT_MIN_CONFIDENCE=0.9` promotes candidates at or above that
confidence straight to accepted memory during capture, leaving everything
below the threshold in the inbox for review.

### End-to-end quick start

```text
/space new learn-event       # 1. create a Learning Space
/space use learn-event       # 2. mount it in this session
/memory on                   # 3. enable recall + generation
# ask Pi something with durable content (concepts, procedures, preferences)
/memory capture              # 4. extract the current turn into candidates
/memory review               # 5. list candidates (mem-job-xxx-N [kind, confidence=...])
/memory accept mem-...-1     # 6. accept what is worth remembering
# ask a related question — accepted memories are now recalled automatically
/space status                # 7. check: Memories: N accepted confirms recall source
```

The next turn's `before_agent_start` embeds the accepted memory and your
question (via the configured embedding backend) and injects matching records
as untrusted, escaped context. `~/.pi/agent/pi-live-data/spaces/<id>/index/vectors.json`
appears once a recall ran.

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
    "shutdownTimeoutMs": 1500,
    "autoAcceptMinConfidence": 0.9,
    "retrieval": {
      "mode": "auto",
      "provider": "local",
      "model": "onnx-community/all-MiniLM-L6-v2-ONNX",
      "rrfK": 60
    }
  }
}
```

`PILIVE_DATA_ROOT` and `PILIVE_MEMORY_MODE` (`off`, `read`, `read-write`, or
`on`) are optional launch-time overrides. Retrieval can also be controlled with
`PILIVE_RETRIEVAL_MODE` (`auto`, `lexical`, or `hybrid`) and
`PILIVE_EMBEDDING_MODEL`. `PILIVE_EMBEDDING_PROVIDER` (`local` or `openrouter`)
selects where embedding vectors come from, and `OPENROUTER_API_KEY` supplies
the OpenRouter credential. The default data root is:

```text
~/.pi/agent/pi-live-data/
├── registry.json
└── spaces/<space-id>/
    ├── inbox/       # generated candidates, not recalled by default
    ├── rejected/    # explicitly rejected candidates with provenance
    ├── memories/    # accepted memory records used for recall
    ├── jobs/        # durable extraction queue and retry state
    └── index/       # derived per-Space vector index (safe to delete/rebuild)
```

`/space new <name>` creates a Space at `dataRoot/spaces/<id>`. Space names keep
Unicode letters such as Chinese readable while removing path separators and
other unsafe characters. Supplying a path uses that location instead, which is
useful for placing memory data in a private directory separate from an
Obsidian vault. Space paths are registered in `registry.json`; the selected
Space itself is stored in the active Pi session branch with `appendEntry`, not
in a process-global variable. Custom paths are canonicalized through their
existing real parent, reject symlink aliases, and cannot be the same as—or a
parent/child of—another registered Space. If the registry is malformed, Pi
Live quarantines it with a timestamped backup and reports the backup path.

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
bounded BM25 + optional semantic recall for the mounted Space only
```

Automatic extraction can be disabled with `autoCapture: false`; `/memory capture`
still runs immediately. Jobs use an expiring cross-process lease,
heartbeat renewal, exponential retry delay, and a maximum attempt count.
Shutdown aborts the request and waits only for the configured bounded timeout;
an unfinished lease is recovered later as stale. Candidates are never injected
into context until explicitly accepted.

Recall is inserted as escaped structured records with project/session/source
provenance. The surrounding prompt marks these records as untrusted reference
data and explicitly excludes commands, policy, permissions, or other embedded
instructions. Invalid queue JSON/schema records are moved to the Space's
`jobs/quarantine/` directory so one damaged job cannot block the queue.

### Remote embeddings via OpenRouter

To use your own hosted embedding model instead of local weights, select the
OpenRouter provider and export a key:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

```json
{
  "memory": {
    "retrieval": {
      "provider": "openrouter",
      "model": "openai/text-embedding-3-small"
    }
  }
}
```

The package calls the OpenAI-compatible endpoint
`POST https://openrouter.ai/api/v1/embeddings` with bearer authentication,
sending memory texts in bounded batches and queries individually with
`encoding_format: float`. Requests carry a bounded timeout, and responses are
validated entry by entry (batch size, finite vectors, order restored from each
element's `index`).

- `provider` defaults to `local` (Transformers.js). Set it to `openrouter` per
  launch instead with `PILIVE_EMBEDDING_PROVIDER=openrouter`.
- `model` defaults to `openai/text-embedding-3-small` for OpenRouter;
  `memory.retrieval.model` or `PILIVE_EMBEDDING_MODEL` picks any other
  embeddings model listed by OpenRouter.
- As a machine-local fallback when environment variables are inconvenient,
  `memory.retrieval.apiKey` can hold the key inside `pi-live.json`; prefer the
  environment variable.

Failure semantics match the local provider exactly. A missing key, network
error, non-2xx status, or malformed payload never blocks the agent turn:
recall silently returns the BM25 result set, `/memory status` appends a warning
when the provider is selected without a key, and switching providers or models
rebuilds each Space's vector index automatically because the index records its
own provider and model.

### Hybrid retrieval

The default `auto` mode always starts safely: if the optional
`@huggingface/transformers` package or its model is unavailable, retrieval is
quietly BM25-only. When the optional provider is available, accepted memories
are embedded with the configured Transformers.js feature-extraction model and
stored in `Space/index/vectors.json`. The index contains only memory IDs,
content fingerprints, and normalized vectors; accepted memory JSON remains the
source of truth.

Each Learning Space has an independent index. New or changed accepted records
are embedded incrementally, deleted records are pruned, and a missing or
malformed index is rebuilt automatically. BM25 and semantic rankings are fused
with Reciprocal Rank Fusion (`rrfK`, default `60`). Provider errors, model
download failures, invalid vectors, dimension changes, permissions errors, and
corrupt index files all return the lexical result set without blocking the
agent turn. Set `mode` to `lexical` to disable the optional provider entirely;
set it to `hybrid` to request semantic retrieval explicitly while retaining the
same lexical fallback.

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
| Retrieval | BM25 lexical ranking plus optional Transformers.js vectors or the OpenRouter embeddings API, per-Space incremental JSON indexes, RRF fusion, and silent lexical fallback |

## License

MIT

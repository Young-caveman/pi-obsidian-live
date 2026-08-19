/**
 * Pi Obsidian Live
 *
 * A minimal reading-surface extension: mirrors the latest N turns of the
 * current Pi conversation into a single Markdown file that Obsidian renders.
 *
 * Commands:
 *   /oblive <path>   Enable live view (default: latest 1 turn)
 *   /oblive <n>      Show the latest n turns (positive integer)
 *   /oblive status   Show current state
 *   /oblive off      Stop writing updates (file is kept)
 *
 * Auto-enable (ON by default): every session writes a live file to the
 * default vault directory (DEFAULT_LIVE_DIR below) with an auto-generated
 * name Pi-Live-<project>-<timestamp>.md. Parallel agents never share a file.
 * Environment overrides:
 *   OBLIVE_OFF=1         Disable auto-enable entirely
 *   OBLIVE_PATH=<file>   Enable at this exact path instead of the default dir
 *   OBLIVE_DIR=<dir>     Enable in this directory with an auto-generated name
 *   OBLIVE_TURNS=<n>     Initial turn window (default 1)
 *
 * Every written file starts with a uniform YAML frontmatter block for
 * Obsidian indexing (type, project, session, model, turns, created,
 * updated, tags) - see Pi-Live-Template.md next to the notes folder.
 *
 * Architecture:
 *   Pi session / streaming events
 *        ↓ extract user + assistant content in original order
 *   filesystem write (atomic: temp file + rename)
 *        ↓
 *   Pi-Live.md  →  Obsidian renders Markdown
 *
 * One "turn" = one user prompt + all model output generated in response
 * until the agent run fully settles (agent_settled). The full model output
 * is preserved in order:
 *   - assistant text                    (verbatim Markdown)
 *   - thinking                          (Obsidian callout, folded by default)
 *   - tool calls and tool results       (Obsidian callouts, folded by default)
 * System messages, internal Pi messages, and metadata never appear.
 *
 * Assistant text is copied verbatim; this extension does not interpret,
 * transform, or summarize any content.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// In-memory configuration (V1: no persistence, no session metadata entries)
// ---------------------------------------------------------------------------

let enabled = false;
let livePath: string | null = null;
let turnCount = 1;
/** ISO timestamp of when the current live file was enabled (frontmatter: created). */
let createdAt: string | null = null;

/**
 * Default vault directory for auto-generated live notes.
 * Override per machine with the OBLIVE_DIR environment variable
 * (or edit this constant to taste).
 */
const DEFAULT_LIVE_DIR = "~/Documents/Obsidian/Pi-Live";

// ---------------------------------------------------------------------------
// Live turn state (only used while an agent run is streaming)
// ---------------------------------------------------------------------------

interface LiveTurn {
  /** The raw expanded user prompt captured from before_agent_start. */
  prompt: string;
  /** Sections of the assistant message currently streaming (not yet persisted). */
  sections: Section[];
}

let liveTurn: LiveTurn | null = null;

// ---------------------------------------------------------------------------
// Debounced writer
// ---------------------------------------------------------------------------

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let scheduledDelay = Number.POSITIVE_INFINITY;
let lastErrorNotifyAt = 0;

function cancelPendingWrite(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
    scheduledDelay = Number.POSITIVE_INFINITY;
  }
}

/** Schedule a trailing write; a later call with a larger delay keeps the earlier deadline. */
function scheduleWrite(ctx: ExtensionContext, delay: number): void {
  if (!enabled || !livePath) return;
  if (writeTimer !== null) {
    if (delay >= scheduledDelay) return;
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  scheduledDelay = delay;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    scheduledDelay = Number.POSITIVE_INFINITY;
    void writeNow(ctx).catch(() => {});
  }, delay);
}

// ---------------------------------------------------------------------------
// Content extraction (verbatim; content is never interpreted)
// ---------------------------------------------------------------------------

/** Extract only human-readable text blocks from a message content value. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n");
}

/**
 * Convert assistant message content blocks into ordered sections, preserving
 * the original order: text, thinking, and tool calls exactly as the model
 * produced them.
 */
function sectionsFromBlocks(content: unknown): Section[] {
  if (!Array.isArray(content)) return [];
  const sections: Section[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
      sections.push({ kind: "text", text: b.text });
    } else if (
      b.type === "thinking" &&
      typeof b.thinking === "string" &&
      b.thinking.length > 0
    ) {
      sections.push({ kind: "thinking", text: b.thinking });
    } else if (b.type === "toolCall" && typeof b.name === "string") {
      let args = "{}";
      try {
        args = JSON.stringify(b.arguments ?? {}, null, 2);
      } catch {
        args = JSON.stringify(String(b.arguments ?? ""));
      }
      sections.push({ kind: "toolCall", name: b.name, args });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Turn reconstruction from the active session branch
// ---------------------------------------------------------------------------

type Section =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; name: string; args: string }
  | { kind: "toolResult"; name: string; content: string; isError: boolean };

interface Turn {
  user: string;
  sections: Section[];
}

interface SessionEntryLike {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    isError?: boolean;
  };
}

interface SessionManagerLike {
  getBranch(): SessionEntryLike[];
}

/**
 * Walk the ACTIVE branch only (root -> leaf). Each user message starts a new
 * turn; assistant content (text, thinking, tool calls) and tool results are
 * appended to the current turn in order. System/internal messages, model
 * changes, compactions, and other non-conversation entries are skipped.
 */
function sessionTurns(sm: SessionManagerLike): Turn[] {
  const turns: Turn[] = [];
  for (const entry of sm.getBranch()) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role === "user") {
      turns.push({ user: extractText(msg.content), sections: [] });
    } else if (msg.role === "assistant") {
      const sections = sectionsFromBlocks(msg.content);
      if (sections.length === 0) continue;
      if (turns.length === 0) turns.push({ user: "", sections: [] });
      turns[turns.length - 1].sections.push(...sections);
    } else if (msg.role === "toolResult") {
      const name = typeof msg.toolName === "string" ? msg.toolName : "tool";
      if (turns.length === 0) turns.push({ user: "", sections: [] });
      turns[turns.length - 1].sections.push({
        kind: "toolResult",
        name,
        content: extractText(msg.content),
        isError: msg.isError === true,
      });
    }
  }
  return turns;
}

/**
 * Recent N turns: completed turns from the session plus, while the agent is
 * streaming, the in-progress assistant message captured from live events.
 */
function currentTurns(sm: SessionManagerLike): Turn[] {
  const turns = sessionTurns(sm);
  if (liveTurn && liveTurn.sections.length > 0) {
    const last = turns[turns.length - 1];
    if (last && last.user === liveTurn.prompt) {
      // The live turn's user message is already persisted in the session;
      // append the streaming message's sections after the persisted ones.
      last.sections = [...last.sections, ...liveTurn.sections];
    } else {
      // User message not persisted yet (or prompt mismatch): append as new turn.
      turns.push({ user: liveTurn.prompt, sections: [...liveTurn.sections] });
    }
  }
  return turns.slice(-turnCount);
}

// ---------------------------------------------------------------------------
// Rendering (Obsidian-native folding via callouts)
// ---------------------------------------------------------------------------

/**
 * Obsidian callout, folded by default (the "-" suffix). Native fold/unfold
 * in reading and live-preview modes. Every body line is prefixed with "> ".
 */
function callout(kind: string, title: string, body: string): string {
  const lines = [`> [!${kind}]- ${title}`];
  for (const line of body.split("\n")) lines.push(`> ${line}`);
  return lines.join("\n");
}

/** Cap tool output for the reading surface; explicit truncation marker. */
function truncateToolOutput(text: string): string {
  const maxLines = 300;
  const maxChars = 50000;
  const lines = text.split("\n");
  let out = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (!truncated && out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) out += "\n… (output truncated for the reading view)";
  return out;
}

/** Render one section. Text is copied verbatim; everything else is folded. */
function renderSection(section: Section): string {
  switch (section.kind) {
    case "text":
      return section.text;
    case "thinking":
      return callout("note", "Thinking", section.text);
    case "toolCall":
      return callout(
        "info",
        `Tool: ${section.name}`,
        "```json\n" + section.args + "\n```",
      );
    case "toolResult":
      return callout(
        section.isError ? "warning" : "quote",
        section.isError
          ? `Tool error: ${section.name}`
          : `Tool result: ${section.name}`,
        "```text\n" + truncateToolOutput(section.content) + "\n```",
      );
  }
}

/** Render turns as role-boundary Markdown with folded model-output sections. */
function renderTurns(turns: Turn[]): string {
  const blocks = turns.map((turn) => {
    const rendered = turn.sections.map(renderSection).filter((s) => s.length > 0);
    const pi = rendered.length > 0 ? rendered.join("\n\n") : "";
    return `## Me\n\n${turn.user}\n\n## Pi\n\n${pi}`;
  });
  return blocks.join("\n\n\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// YAML frontmatter (uniform, indexable metadata for Obsidian)
// ---------------------------------------------------------------------------

/** Double-quote a YAML scalar value safely. */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Tag-safe version of a project name: lowercase, no spaces or symbols. */
function tagSafe(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "pi"
  );
}

/**
 * Uniform YAML frontmatter for every live file. Structure mirrors
 * Pi-Live-Template.md in the vault so all files share one schema.
 */
function buildFrontmatter(ctx: ExtensionContext): string {
  const project = sanitizeName(basename(ctx.cwd));
  const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
  const created = createdAt ?? localIso();
  return [
    "---",
    "type: pi-live",
    `project: ${yamlStr(project)}`,
    `session: ${yamlStr(sessionId)}`,
    `model: ${yamlStr(model)}`,
    `turns: ${turnCount}`,
    `created: ${yamlStr(created)}`,
    `updated: ${yamlStr(localIso())}`,
    "tags:",
    "  - pi-live",
    `  - ${tagSafe(project)}`,
    "---",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

/** Expand a leading "~" and resolve to an absolute path. */
function resolvePath(input: string): string {
  let p = input;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return resolve(p);
}

/** Filesystem-safe base name derived from a project directory name. */
function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .replace(/[ .]+$/, "");
  return cleaned || "pi";
}

/** Local time formatted for file names: 2026-08-19-16-30-45. */
function localTimestamp(): string {
  const d = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/** Local ISO timestamp with timezone offset: 2026-08-19T16:30:00+08:00. */
function localIso(): string {
  const d = new Date();
  const pad = (v: number) => String(v).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * Auto file name for OBLIVE_DIR: Pi-Live-<project>-<timestamp>.md.
 * If that name already exists, append -2, -3, ... so parallel agents
 * starting at the same second never share a file.
 */
function nextAvailableAutoPath(dirInput: string, projectDir: string): string {
  const dir = resolvePath(dirInput);
  const project = sanitizeName(basename(projectDir));
  const base = `Pi-Live-${project}-${localTimestamp()}`;
  let target = join(dir, `${base}.md`);
  let i = 2;
  while (existsSync(target)) {
    target = join(dir, `${base}-${i}.md`);
    i++;
  }
  return target;
}

/** OBLIVE_TURNS if it is a positive integer, otherwise null. */
function readTurnCountEnv(): number | null {
  const raw = process.env.OBLIVE_TURNS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Atomic write: write to a temp file in the same directory, then rename.
 * Obsidian never sees a half-written file.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.oblive-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Build the current view and write it. Never throws. */
async function writeNow(ctx: ExtensionContext): Promise<boolean> {
  if (!enabled || !livePath) return false;
  try {
    const content =
      buildFrontmatter(ctx) + renderTurns(currentTurns(ctx.sessionManager));
    await atomicWrite(livePath, content);
    return true;
  } catch (error) {
    notifyWriteError(ctx, (error as Error).message);
    return false;
  }
}

/** Throttled write-failure notifications (streaming can retry every ~300ms). */
function notifyWriteError(ctx: ExtensionContext, message: string): void {
  const now = Date.now();
  if (now - lastErrorNotifyAt >= 5000) {
    lastErrorNotifyAt = now;
    ctx.ui.notify(`Obsidian Live: file write failed: ${message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // --- auto-enable (ON by default; multi-agent friendly) ------------------
  // Every session writes to DEFAULT_LIVE_DIR unless overridden or disabled.
  // OBLIVE_PATH=<file>  exact target file
  // OBLIVE_DIR=<dir>    auto-generated file name inside this dir
  // OBLIVE_TURNS=<n>    initial turn window (default 1)
  // OBLIVE_OFF=1        disable auto-enable
  pi.on("session_start", async (_event, ctx) => {
    if (enabled) return;
    if (process.env.OBLIVE_OFF?.trim() === "1") return;
    const pathEnv = process.env.OBLIVE_PATH?.trim();
    const dirEnv = process.env.OBLIVE_DIR?.trim();
    const target = pathEnv
      ? resolvePath(pathEnv)
      : nextAvailableAutoPath(dirEnv ?? DEFAULT_LIVE_DIR, ctx.cwd);
    const n = readTurnCountEnv();
    if (n !== null) turnCount = n;
    createdAt = localIso();
    enabled = true;
    livePath = target;
    liveTurn = null;
    cancelPendingWrite();
    if (await writeNow(ctx)) {
      ctx.ui.notify(
        `Obsidian Live: ON (auto)\nPath: ${target}\nTurns: ${turnCount}`,
        "info",
      );
    } else {
      enabled = false;
      livePath = null;
    }
  });

  // --- turn start: capture the user prompt -------------------------------
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled || !livePath) return;
    liveTurn = { prompt: event.prompt, sections: [] };
    scheduleWrite(ctx, 0);
  });

  // --- assistant streaming ------------------------------------------------
  // The streaming message is rebuilt from each partial update and merged
  // into the view on write; on message_end it is dropped because the session
  // persists the final version (extensions run before persistence).
  pi.on("message_start", async (event, ctx) => {
    if (!enabled || !liveTurn) return;
    if (event.message.role !== "assistant") return;
    liveTurn.sections = [];
    scheduleWrite(ctx, 200);
  });

  pi.on("message_update", async (event, ctx) => {
    if (!enabled || !liveTurn) return;
    if (event.message.role !== "assistant") return;
    liveTurn.sections = sectionsFromBlocks(event.message.content);
    scheduleWrite(ctx, 300);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!enabled || !liveTurn) return;
    if (event.message.role !== "assistant") return;
    liveTurn.sections = [];
    scheduleWrite(ctx, 150);
  });

  // --- turn finished: authoritative final write from the session ----------
  pi.on("agent_settled", async (_event, ctx) => {
    if (!enabled || !livePath) return;
    liveTurn = null;
    await writeNow(ctx);
  });

  // --- cleanup on session teardown -----------------------------------------
  pi.on("session_shutdown", async () => {
    cancelPendingWrite();
  });

  // --- /oblive command -----------------------------------------------------
  pi.registerCommand("oblive", {
    description: "Obsidian Live: mirror latest Pi turns to a Markdown file",
    handler: async (args, ctx) => {
      const arg = args.trim();
      try {
        if (arg === "" || arg === "help") {
          ctx.ui.notify(
            "Obsidian Live: /oblive <path> | /oblive <n> | /oblive status | /oblive off",
            "info",
          );
          return;
        }

        if (arg === "status") {
          if (!enabled || !livePath) {
            ctx.ui.notify("Obsidian Live: OFF", "info");
          } else {
            ctx.ui.notify(
              `Obsidian Live: ON\nPath: ${livePath}\nTurns: ${turnCount}`,
              "info",
            );
          }
          return;
        }

        if (arg === "off") {
          if (!enabled) {
            ctx.ui.notify("Obsidian Live: OFF", "info");
            return;
          }
          enabled = false;
          livePath = null;
          liveTurn = null;
          cancelPendingWrite();
          ctx.ui.notify("Obsidian Live: OFF", "info");
          return;
        }

        if (/^\d+$/.test(arg)) {
          const n = Number.parseInt(arg, 10);
          if (!Number.isFinite(n) || n < 1) {
            ctx.ui.notify(
              `Obsidian Live: invalid turn count "${arg}" (must be a positive integer)`,
              "error",
            );
            return;
          }
          turnCount = n;
          ctx.ui.notify(
            `Obsidian Live: showing last ${n} turn${n === 1 ? "" : "s"}`,
            "info",
          );
          if (enabled && livePath) await writeNow(ctx);
          return;
        }

        // Otherwise: treat as a file path → enable live view.
        const target = resolvePath(arg);
        // Probe by writing the current view first; only enable on success
        // so an invalid path fails fast with a useful notification.
        enabled = true;
        livePath = target;
        turnCount = 1;
        createdAt = localIso();
        liveTurn = null;
        cancelPendingWrite();
        if (await writeNow(ctx)) {
          ctx.ui.notify(
            `Obsidian Live: ON\nPath: ${target}\nTurns: 1`,
            "info",
          );
        } else {
          enabled = false;
          livePath = null;
        }
      } catch (error) {
        ctx.ui.notify(`Obsidian Live: ${(error as Error).message}`, "error");
      }
    },
  });
}

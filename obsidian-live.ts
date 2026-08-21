/**
 * Pi Obsidian Live
 *
 * A minimal reading-surface extension: mirrors the latest N turns of the
 * current Pi conversation into a single Markdown file that Obsidian renders.
 *
 * Commands:
 *   /oblive <path>                                  Enable live view (default: latest 1 turn)
 *   /oblive <n>                                     Show the latest n turns (positive integer)
 *   /oblive status                                  Show current state
 *   /oblive off                                     Stop writing updates (file is kept)
 *   /oblive {repair|thinking|tools|template} [on|off]
 *                                                  Toggle or set each flag (no value = flip current)
 *
 * Auto-enable (ON by default): every session writes a live file to the
 * default vault directory (DEFAULT_LIVE_DIR below) with an auto-generated
 * name Pi-Live-<project>-<timestamp>.md. Parallel agents never share a file.
 *
 * Machine-local configuration (optional): ~/.pi/agent/oblive.json
 *   {
 *     "liveDir": "/path/to/vault/Notes",   // default directory
 *     "livePath": "/path/to/file.md",      // exact default file
 *     "turns": 3,                          // default window size
 *     "autoEnable": false,                 // disable auto-enable
 *     "template": false,                   // omit YAML frontmatter
 *     "thinking": false,                   // omit thinking callouts
 *     "tools": false                       // omit tool call / tool result callouts
 *   }
 *
 * Environment overrides (per launch, highest priority):
 *   OBLIVE_OFF=1         Disable auto-enable entirely
 *   OBLIVE_PATH=<file>   Enable at this exact path instead of the default dir
 *   OBLIVE_DIR=<dir>     Enable in this directory with an auto-generated name
 *   OBLIVE_TURNS=<n>     Initial turn window
 *   OBLIVE_TEMPLATE=0/1  Disable/enable YAML frontmatter
 *   OBLIVE_THINKING=0/1  Disable/enable thinking callouts
 *   OBLIVE_TOOLS=0/1     Disable/enable tool call / tool result callouts
 *
 * Priority: env vars > config file > built-in default.
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
 * Markdown cascade protection: at the end of a run the rendered body is
 * checked for an odd number of triple-backtick fence lines; if so, one
 * closing fence is appended. This is mechanical delimiter balancing only
 * (never changes model content) and prevents a single unclosed code block
 * from causing the rest of the file to render as code. Streaming writes
 * skip this check, so partial in-flight code blocks render normally and
 * normalize at agent_settled.
 *
 * Assistant text is otherwise copied verbatim; this extension does not
 * interpret, transform, or summarize any content.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// In-memory configuration (V1: no persistence, no session metadata entries)
// ---------------------------------------------------------------------------

let enabled = false;
let livePath: string | null = null;
let turnCount = 1;
/** Whether files start with the YAML frontmatter template (default true). */
let withTemplate = true;
/** Whether thinking content blocks render as callouts (default true). */
let showThinking = true;
/** Whether tool call and tool result blocks render as callouts (default true). */
let showTools = true;
/** Whether cascade-protection fence balancing runs at agent_settled (default true). */
let repair = true;
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

function onOff(b: boolean): string {
  return b ? "on" : "off";
}

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

/** Filter sections according to the current show-thinking / show-tools flags. */
function visibleSections(sections: Section[]): Section[] {
  return sections.filter((s) => {
    if (s.kind === "thinking" && !showThinking) return false;
    if ((s.kind === "toolCall" || s.kind === "toolResult") && !showTools) {
      return false;
    }
    return true;
  });
}

/** Render turns as role-boundary Markdown with folded model-output sections. */
function renderTurns(turns: Turn[]): string {
  const blocks = turns.map((turn) => {
    const rendered = visibleSections(turn.sections)
      .map(renderSection)
      .filter((s) => s.length > 0);
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

/** OBLIVE_TEMPLATE parsed as a boolean, or null if unset/invalid. */
function readTemplateEnv(): boolean | null {
  const raw = process.env.OBLIVE_TEMPLATE?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return null;
}

/** Parse a boolean env var (0/false/off = false, 1/true/on = true), else null. */
function readBoolEnv(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return null;
}

// ---------------------------------------------------------------------------
// Machine-local configuration file (~/.pi/agent/oblive.json)
// ---------------------------------------------------------------------------

interface ObliveConfig {
  liveDir?: string;
  livePath?: string;
  turns?: number;
  autoEnable?: boolean;
  /** Whether files start with the YAML frontmatter template. Default true. */
  template?: boolean;
  /** Whether thinking blocks render as callouts. Default true. */
  thinking?: boolean;
  /** Whether tool call / tool result blocks render as callouts. Default true. */
  tools?: boolean;
  /** Whether cascade-protection fence balancing runs at agent_settled. Default true. */
  repair?: boolean;
}

/**
 * Load the optional local config file. Missing file -> empty config.
 * Malformed file or invalid fields -> ignored with a one-time warning.
 */
function loadConfig(ctx: ExtensionContext): ObliveConfig {
  const file = join(getAgentDir(), "oblive.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      ctx.ui.notify(
        `Obsidian Live: cannot read ${file}: ${(error as Error).message}`,
        "error",
      );
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cfg: ObliveConfig = {};
    if (typeof parsed.liveDir === "string" && parsed.liveDir.trim() !== "") {
      cfg.liveDir = parsed.liveDir;
    }
    if (typeof parsed.livePath === "string" && parsed.livePath.trim() !== "") {
      cfg.livePath = parsed.livePath;
    }
    if (
      typeof parsed.turns === "number" &&
      Number.isInteger(parsed.turns) &&
      parsed.turns >= 1
    ) {
      cfg.turns = parsed.turns;
    }
    if (typeof parsed.autoEnable === "boolean") {
      cfg.autoEnable = parsed.autoEnable;
    }
    if (typeof parsed.template === "boolean") {
      cfg.template = parsed.template;
    }
    if (typeof parsed.thinking === "boolean") {
      cfg.thinking = parsed.thinking;
    }
    if (typeof parsed.tools === "boolean") {
      cfg.tools = parsed.tools;
    }
    if (typeof parsed.repair === "boolean") {
      cfg.repair = parsed.repair;
    }
    return cfg;
  } catch (error) {
    ctx.ui.notify(
      `Obsidian Live: invalid JSON in ${file} - using defaults`,
      "error",
    );
    return {};
  }
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

/** Build the current view and write it. Never throws.
 *  `opts.repair` triggers cascade-protection at the end of a run. */
async function writeNow(
  ctx: ExtensionContext,
  opts: { repair?: boolean } = {},
): Promise<boolean> {
  if (!enabled || !livePath) return false;
  try {
    let body = renderTurns(currentTurns(ctx.sessionManager));
    if (opts.repair) body = repairMarkdown(body);
    const content = withTemplate ? buildFrontmatter(ctx) + body : body;
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

/**
 * Minimal cascade-protection for the final rendered body. Counts lines
 * beginning with triple backticks (the only markdown construct whose
 * unclosed state corrupts the rest of the file); if the count is odd,
 * appends one closing fence line. Never modifies model content - adds at
 * most one line. Applied only at the end of a run (agent_settled), never
 * during streaming, to avoid clashing with the model's own closing fence.
 */
function repairMarkdown(text: string): string {
  let fenceCount = 0;
  for (const line of text.split("\n")) {
    if (/^```/.test(line)) fenceCount++;
  }
  if (fenceCount % 2 === 1) return text + "\n```\n";
  return text;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // --- auto-enable (ON by default; multi-agent friendly) ------------------
  // Target resolution: OBLIVE_PATH > OBLIVE_DIR (env) > config livePath /
  // liveDir (~/.pi/agent/oblive.json) > DEFAULT_LIVE_DIR. OBLIVE_OFF=1 or
  // config autoEnable:false disables auto-enable.
  pi.on("session_start", async (_event, ctx) => {
    if (enabled) return;
    const cfg = loadConfig(ctx);
    if (process.env.OBLIVE_OFF?.trim() === "1") return;
    if (cfg.autoEnable === false) return;
    const pathEnv = process.env.OBLIVE_PATH?.trim();
    const dirEnv = process.env.OBLIVE_DIR?.trim();
    const target = pathEnv
      ? resolvePath(pathEnv)
      : dirEnv
        ? nextAvailableAutoPath(dirEnv, ctx.cwd)
        : cfg.livePath
          ? resolvePath(cfg.livePath)
          : nextAvailableAutoPath(cfg.liveDir ?? DEFAULT_LIVE_DIR, ctx.cwd);
    const n = readTurnCountEnv() ?? cfg.turns ?? null;
    if (n !== null) turnCount = n;
    const t = readTemplateEnv() ?? cfg.template ?? null;
    if (t !== null) withTemplate = t;
    const th = readBoolEnv("OBLIVE_THINKING") ?? cfg.thinking ?? null;
    if (th !== null) showThinking = th;
    const tl = readBoolEnv("OBLIVE_TOOLS") ?? cfg.tools ?? null;
    if (tl !== null) showTools = tl;
    const rp = readBoolEnv("OBLIVE_REPAIR") ?? cfg.repair ?? null;
    if (rp !== null) repair = rp;
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
    await writeNow(ctx, { repair });
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
            "Obsidian Live:\n" +
              "  /oblive <path|n>            enable at path or set turn count\n" +
              "  /oblive status | off        show state | stop writing\n" +
              "  /oblive {repair|thinking|tools|template} [on|off]\n" +
              "                             toggle or set a flag (no value = flip)",
            "info",
          );
          return;
        }

        if (arg === "status") {
          if (!enabled || !livePath) {
            ctx.ui.notify("Obsidian Live: OFF", "info");
          } else {
            ctx.ui.notify(
              `Obsidian Live: ON\n` +
                `Path: ${livePath}\n` +
                `Turns: ${turnCount}\n` +
                `Template: ${onOff(withTemplate)}  Repair: ${onOff(repair)}\n` +
                `Thinking: ${onOff(showThinking)}  Tools: ${onOff(showTools)}`,
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

        // Toggle subcommands: /oblive <flag> [on|off] (no value flips current).
        // If the first token looks like a flag name, we treat the whole arg as
        // a toggle command (even when the value is invalid, which becomes an
        // error notification rather than silently treating it as a path).
        // Paths starting with "/" or "~" are unaffected; relative paths whose
        // first token coincidentally matches a flag name fall through to the
        // path branch only when the token is not exactly the flag (e.g.
        // "tools.md" - ".md" makes the first token not match).
        const flagNames = ["repair", "thinking", "tools", "template"] as const;
        const firstWord = arg.split(/\s+/)[0]?.toLowerCase();
        if (
          firstWord !== undefined &&
          (flagNames as readonly string[]).includes(firstWord)
        ) {
          const toggleMatch =
            /^(repair|thinking|tools|template)(?:\s+(on|off|true|false|0|1))?$/i.exec(arg);
          if (!toggleMatch) {
            ctx.ui.notify(
              `Obsidian Live: invalid value for ${firstWord} (use on/off/true/false/0/1, or omit to toggle)`,
              "error",
            );
            return;
          }
          const flag = toggleMatch[1].toLowerCase();
          const valueArg = toggleMatch[2]?.toLowerCase();
          const current =
            flag === "repair"
              ? repair
              : flag === "thinking"
                ? showThinking
                : flag === "tools"
                  ? showTools
                  : withTemplate;
          const newValue =
            valueArg === undefined
              ? !current
              : ["on", "true", "1"].includes(valueArg);
          if (flag === "repair") repair = newValue;
          else if (flag === "thinking") showThinking = newValue;
          else if (flag === "tools") showTools = newValue;
          else withTemplate = newValue;
          ctx.ui.notify(
            `Obsidian Live: ${flag} ${newValue ? "on" : "off"}`,
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

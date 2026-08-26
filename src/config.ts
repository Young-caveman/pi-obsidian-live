import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type MemoryMode = "off" | "read" | "read-write";

export interface PiLiveConfig {
  dataRoot?: string;
  memory?: {
    mode?: MemoryMode;
    autoCapture?: boolean;
    captureIdleMs?: number;
    minTextChars?: number;
    retrievalLimit?: number;
    maxPromptChars?: number;
    jobLeaseMs?: number;
    maxJobAttempts?: number;
    shutdownTimeoutMs?: number;
  };
}

export const DEFAULT_DATA_ROOT = "~/.pi/agent/pi-live-data";
export const PI_LIVE_CONFIG_NAME = "pi-live.json";

export function resolvePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(join(homedir(), input.slice(2)));
  return resolve(input);
}

export function defaultDataRoot(): string {
  return resolvePath(DEFAULT_DATA_ROOT);
}

function isMemoryMode(value: unknown): value is MemoryMode {
  return value === "off" || value === "read" || value === "read-write";
}

export function parsePiLiveConfig(raw: string): PiLiveConfig {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const result: PiLiveConfig = {};
  if (typeof value.dataRoot === "string" && value.dataRoot.trim()) {
    result.dataRoot = value.dataRoot.trim();
  }
  if (value.memory && typeof value.memory === "object") {
    const memory = value.memory as Record<string, unknown>;
    const parsed: NonNullable<PiLiveConfig["memory"]> = {};
    if (isMemoryMode(memory.mode)) parsed.mode = memory.mode;
    if (typeof memory.autoCapture === "boolean") parsed.autoCapture = memory.autoCapture;
    if (typeof memory.captureIdleMs === "number" && Number.isInteger(memory.captureIdleMs) && memory.captureIdleMs >= 1000) {
      parsed.captureIdleMs = Math.min(memory.captureIdleMs, 24 * 60 * 60 * 1000);
    }
    if (typeof memory.minTextChars === "number" && Number.isInteger(memory.minTextChars) && memory.minTextChars >= 1) {
      parsed.minTextChars = memory.minTextChars;
    }
    if (typeof memory.retrievalLimit === "number" && Number.isInteger(memory.retrievalLimit) && memory.retrievalLimit >= 1) {
      parsed.retrievalLimit = Math.min(memory.retrievalLimit, 20);
    }
    if (typeof memory.maxPromptChars === "number" && Number.isInteger(memory.maxPromptChars) && memory.maxPromptChars >= 500) {
      parsed.maxPromptChars = Math.min(memory.maxPromptChars, 20000);
    }
    if (typeof memory.jobLeaseMs === "number" && Number.isInteger(memory.jobLeaseMs) && memory.jobLeaseMs >= 1000) {
      parsed.jobLeaseMs = Math.min(memory.jobLeaseMs, 60 * 60 * 1000);
    }
    if (typeof memory.maxJobAttempts === "number" && Number.isInteger(memory.maxJobAttempts) && memory.maxJobAttempts >= 1) {
      parsed.maxJobAttempts = Math.min(memory.maxJobAttempts, 10);
    }
    if (typeof memory.shutdownTimeoutMs === "number" && Number.isInteger(memory.shutdownTimeoutMs) && memory.shutdownTimeoutMs >= 100) {
      parsed.shutdownTimeoutMs = Math.min(memory.shutdownTimeoutMs, 10000);
    }
    result.memory = parsed;
  }
  return result;
}

export function readPiLiveConfig(agentDir: string, notify?: (message: string) => void): PiLiveConfig {
  const file = join(agentDir, PI_LIVE_CONFIG_NAME);
  try {
    const raw = readFileSync(file, "utf8");
    return parsePiLiveConfig(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") notify?.(`Pi Live: invalid ${file}; using defaults`);
    return {};
  }
}

export function effectiveDataRoot(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PILIVE_DATA_ROOT?.trim() || config.dataRoot || DEFAULT_DATA_ROOT;
  return resolvePath(configured);
}

export function effectiveMemoryMode(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): MemoryMode {
  const raw = env.PILIVE_MEMORY_MODE?.trim().toLowerCase();
  if (raw === "off" || raw === "read" || raw === "read-write") return raw;
  if (raw === "on") return "read-write";
  return config.memory?.mode ?? "off";
}

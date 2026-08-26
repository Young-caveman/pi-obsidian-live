import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type MemoryMode = "off" | "read" | "read-write";
export type RetrievalMode = "auto" | "lexical" | "hybrid";
/** Where embedding vectors come from: local Transformers.js weights or the OpenRouter embeddings API. */
export type EmbeddingProviderKind = "local" | "openrouter";

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
    /** Candidates with confidence >= this value skip the inbox and are accepted directly. */
    autoAcceptMinConfidence?: number;
    retrieval?: {
      mode?: RetrievalMode;
      model?: string;
      rrfK?: number;
      provider?: EmbeddingProviderKind;
      /** Machine-local alternative to OPENROUTER_API_KEY; prefer the environment variable. */
      apiKey?: string;
    };
  };
}

export const DEFAULT_DATA_ROOT = "~/.pi/agent/pi-live-data";
export const PI_LIVE_CONFIG_NAME = "pi-live.json";
export const DEFAULT_EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";
export const DEFAULT_OPENROUTER_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

function isEmbeddingProviderKind(value: unknown): value is EmbeddingProviderKind {
  return value === "local" || value === "openrouter";
}

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

function isRetrievalMode(value: unknown): value is RetrievalMode {
  return value === "auto" || value === "lexical" || value === "hybrid";
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
    if (typeof memory.autoAcceptMinConfidence === "number" && Number.isFinite(memory.autoAcceptMinConfidence) && memory.autoAcceptMinConfidence >= 0 && memory.autoAcceptMinConfidence <= 1) {
      parsed.autoAcceptMinConfidence = memory.autoAcceptMinConfidence;
    }
    if (memory.retrieval && typeof memory.retrieval === "object") {
      const retrieval = memory.retrieval as Record<string, unknown>;
      const parsedRetrieval: NonNullable<PiLiveConfig["memory"]>["retrieval"] = {};
      if (isRetrievalMode(retrieval.mode)) parsedRetrieval.mode = retrieval.mode;
      if (typeof retrieval.model === "string" && retrieval.model.trim()) {
        parsedRetrieval.model = retrieval.model.trim().slice(0, 200);
      }
      if (typeof retrieval.rrfK === "number" && Number.isInteger(retrieval.rrfK) && retrieval.rrfK >= 1) {
        parsedRetrieval.rrfK = Math.min(retrieval.rrfK, 200);
      }
      if (isEmbeddingProviderKind(retrieval.provider)) parsedRetrieval.provider = retrieval.provider;
      if (typeof retrieval.apiKey === "string" && retrieval.apiKey.trim()) {
        parsedRetrieval.apiKey = retrieval.apiKey.trim();
      }
      parsed.retrieval = parsedRetrieval;
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

export function effectiveRetrievalMode(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): RetrievalMode {
  const raw = env.PILIVE_RETRIEVAL_MODE?.trim().toLowerCase();
  if (raw === "auto" || raw === "lexical" || raw === "hybrid") return raw;
  return config.memory?.retrieval?.mode ?? "auto";
}

export function effectiveEmbeddingProviderKind(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): EmbeddingProviderKind {
  const raw = env.PILIVE_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (raw === "openrouter" || raw === "local") return raw;
  return config.memory?.retrieval?.provider ?? "local";
}

/** The embedding model only if the operator explicitly chose one (env wins over config). */
export function effectiveOptionalEmbeddingModel(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PILIVE_EMBEDDING_MODEL?.trim() || config.memory?.retrieval?.model?.trim() || undefined;
}

export function effectiveEmbeddingModel(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): string {
  return effectiveOptionalEmbeddingModel(config, env) ?? DEFAULT_EMBEDDING_MODEL;
}

/** The model id actually used for retrieval, resolved per provider kind. */
export function embeddingModelLabel(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = effectiveOptionalEmbeddingModel(config, env);
  return effectiveEmbeddingProviderKind(config, env) === "openrouter"
    ? explicit ?? DEFAULT_OPENROUTER_EMBEDDING_MODEL
    : explicit ?? DEFAULT_EMBEDDING_MODEL;
}

/** OpenRouter credential: OPENROUTER_API_KEY first, then the machine-local config file. */
export function effectiveEmbeddingApiKey(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[OPENROUTER_API_KEY_ENV]?.trim() || config.memory?.retrieval?.apiKey?.trim() || undefined;
}

/** Automatic-accept threshold (0..1); unset means every candidate needs explicit `/memory accept`. */
export function effectiveAutoAcceptMinConfidence(config: PiLiveConfig, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.PILIVE_AUTO_ACCEPT_MIN_CONFIDENCE?.trim();
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  return config.memory?.autoAcceptMinConfidence;
}

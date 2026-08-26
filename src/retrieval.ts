import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { EmbeddingProviderKind, RetrievalMode } from "./config.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_OPENROUTER_EMBEDDING_MODEL, resolvePath } from "./config.js";
import { atomicWrite, enqueueSpaceWrite } from "./storage.js";
import type { SpaceDefinition } from "./space.js";

export interface MemoryProvenance {
  spaceId: string;
  projectId: string;
  sessionId: string;
  source: string;
  kind: string;
  confidence: number;
  createdAt: string;
}

export interface AcceptedMemory extends MemoryProvenance {
  id: string;
  status: "accepted";
  text: string;
}

export interface RetrievalResult {
  memory: AcceptedMemory;
  /** Lexical score for lexical retrieval, or fused RRF score for hybrid retrieval. */
  score: number;
}

export interface RetrievalBackend {
  readonly name: string;
  search(spaces: readonly SpaceDefinition[], query: string, limit: number): Promise<RetrievalResult[]>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly modelId: string;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface RetrievalBackendOptions {
  mode?: RetrievalMode;
  model?: string;
  rrfK?: number;
  embeddingProvider?: EmbeddingProvider;
  providerKind?: EmbeddingProviderKind;
  /** OpenRouter credential; usually resolved from OPENROUTER_API_KEY by the caller. */
  embeddingApiKey?: string;
}

const DEFAULT_RRF_K = 60;
const VECTOR_BATCH_SIZE = 32;
const MAX_SEMANTIC_CANDIDATES = 100;

const STOP_WORDS = new Set([
  "about", "after", "also", "been", "being", "from", "have", "into", "just", "more", "than", "that", "their", "them", "there", "these", "they", "this", "what", "when", "where", "which", "with", "would", "your",
]);

export function lexicalTokens(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)?.filter((token) => !STOP_WORDS.has(token)) ?? [];
}

interface LexicalStats {
  documentCount: number;
  averageDocumentLength: number;
  documentFrequency: Map<string, number>;
}

function buildLexicalStats(texts: readonly string[]): LexicalStats {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  for (const text of texts) {
    const documentTokens = lexicalTokens(text);
    const tokens = new Set(documentTokens);
    totalLength += documentTokens.length;
    for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  }
  return {
    documentCount: Math.max(1, texts.length),
    averageDocumentLength: Math.max(1, totalLength / Math.max(1, texts.length)),
    documentFrequency,
  };
}

function bm25ScoreWithStats(query: string, text: string, stats: LexicalStats): number {
  const queryTokens = lexicalTokens(query);
  if (queryTokens.length === 0) return 0;
  const documentTokens = lexicalTokens(text);
  if (documentTokens.length === 0) return 0;
  const frequencies = new Map<string, number>();
  for (const token of documentTokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const termFrequency = frequencies.get(token) ?? 0;
    if (termFrequency === 0) continue;
    const documentFrequency = stats.documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + (stats.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const normalization = k1 * (1 - b + b * documentTokens.length / stats.averageDocumentLength);
    score += idf * (termFrequency * (k1 + 1)) / (termFrequency + normalization);
  }
  const phrase = query.trim().toLocaleLowerCase();
  if (phrase.length >= 8 && text.toLocaleLowerCase().includes(phrase)) score += 1;
  return score;
}

/** BM25-like lexical score kept as a small public utility for callers/tests. */
export function bm25Score(query: string, text: string, corpus: readonly string[] = [text]): number {
  return bm25ScoreWithStats(query, text, buildLexicalStats(corpus));
}

/** Backwards-compatible lexical score name. The backend now uses BM25 ranking. */
export function lexicalScore(query: string, text: string): number {
  return bm25Score(query, text);
}

async function readAcceptedMemories(space: SpaceDefinition): Promise<AcceptedMemory[]> {
  const dir = join(resolvePath(space.path), "memories");
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const memories: AcceptedMemory[] = [];
  for (const name of names.sort()) {
    try {
      const value = JSON.parse(await fs.readFile(join(dir, name), "utf8")) as Partial<AcceptedMemory>;
      if (value.status !== "accepted" || value.spaceId !== space.id || typeof value.text !== "string" || !value.text.trim()) continue;
      if (typeof value.id !== "string" || typeof value.projectId !== "string" || typeof value.sessionId !== "string" || typeof value.source !== "string" || typeof value.kind !== "string" || typeof value.createdAt !== "string") continue;
      memories.push({
        id: value.id,
        status: "accepted",
        spaceId: value.spaceId,
        projectId: value.projectId,
        sessionId: value.sessionId,
        source: value.source,
        kind: value.kind,
        confidence: typeof value.confidence === "number" ? value.confidence : 0,
        createdAt: value.createdAt,
        text: value.text,
      });
    } catch {
      // A corrupt or partially-created derived record must not break recall.
    }
  }
  return memories;
}

export class LexicalRetrievalBackend implements RetrievalBackend {
  readonly name = "lexical-bm25";

  async search(spaces: readonly SpaceDefinition[], query: string, limit: number): Promise<RetrievalResult[]> {
    const records = (await Promise.all(spaces.map(readAcceptedMemories))).flat();
    const stats = buildLexicalStats(records.map((record) => record.text));
    return records
      .map((memory) => ({ memory, score: bm25ScoreWithStats(query, memory.text, stats) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt) || a.memory.id.localeCompare(b.memory.id))
      .slice(0, Math.max(1, limit));
  }
}

interface VectorIndexRecord {
  id: string;
  fingerprint: string;
  vector: number[];
}

interface VectorIndexFile {
  version: 1;
  spaceId: string;
  provider: string;
  model: string;
  dimensions: number;
  updatedAt: string;
  records: VectorIndexRecord[];
}

function vectorIndexPath(space: SpaceDefinition): string {
  return join(resolvePath(space.path), "index", "vectors.json");
}

function fingerprint(memory: Pick<AcceptedMemory, "id" | "text">): string {
  return createHash("sha256").update(`${memory.id}\0${memory.text}`).digest("hex");
}

function normalizeVector(vector: readonly number[]): number[] {
  const values = vector.map(Number);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) throw new Error("Embedding provider returned an invalid vector");
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("Embedding provider returned a zero vector");
  return values.map((value) => value / norm);
}

function validVectorRecord(value: unknown, dimensions?: number): value is VectorIndexRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<VectorIndexRecord>;
  return typeof record.id === "string" && typeof record.fingerprint === "string" && Array.isArray(record.vector) &&
    record.vector.length > 0 && (dimensions === undefined || record.vector.length === dimensions) &&
    record.vector.every((number) => typeof number === "number" && Number.isFinite(number));
}

async function readVectorIndex(space: SpaceDefinition, provider: EmbeddingProvider): Promise<VectorIndexFile | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(vectorIndexPath(space), "utf8")) as Partial<VectorIndexFile>;
    if (value.version !== 1 || value.spaceId !== space.id || value.provider !== provider.name || value.model !== provider.modelId || !Array.isArray(value.records)) return undefined;
    const dimensions = typeof value.dimensions === "number" && Number.isInteger(value.dimensions) ? value.dimensions : undefined;
    if (!dimensions || !value.records.every((record) => validVectorRecord(record, dimensions))) return undefined;
    return {
      version: 1,
      spaceId: space.id,
      provider: provider.name,
      model: provider.modelId,
      dimensions,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      records: value.records,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // A damaged derived index is rebuilt when the optional provider works.
    return undefined;
  }
}

async function writeVectorIndex(space: SpaceDefinition, index: VectorIndexFile): Promise<void> {
  await atomicWrite(vectorIndexPath(space), JSON.stringify(index, null, 2) + "\n");
}

async function embedInBatches(provider: EmbeddingProvider, records: readonly AcceptedMemory[]): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>();
  for (let start = 0; start < records.length; start += VECTOR_BATCH_SIZE) {
    const batch = records.slice(start, start + VECTOR_BATCH_SIZE);
    const embedded = await provider.embed(batch.map((record) => record.text));
    if (embedded.length !== batch.length) throw new Error("Embedding provider returned the wrong batch size");
    for (let index = 0; index < batch.length; index++) vectors.set(batch[index].id, normalizeVector(embedded[index]));
  }
  return vectors;
}

async function ensureVectorIndex(space: SpaceDefinition, memories: readonly AcceptedMemory[], provider: EmbeddingProvider): Promise<VectorIndexFile> {
  const existing = await readVectorIndex(space, provider);
  const existingById = new Map(existing?.records.map((record) => [record.id, record]) ?? []);
  const missing = memories.filter((memory) => {
    const record = existingById.get(memory.id);
    return !record || record.fingerprint !== fingerprint(memory);
  });
  const hasStaleRecords = !existing || existing.records.length !== memories.length || memories.some((memory) => !existingById.has(memory.id));
  if (existing && missing.length === 0 && !hasStaleRecords) return existing;
  const embedded = missing.length > 0 ? await embedInBatches(provider, missing) : new Map<string, number[]>();
  const dimensions = existing?.dimensions ?? embedded.values().next().value?.length;
  if (dimensions === undefined && memories.length > 0) throw new Error("Embedding provider returned no dimensions");
  if (dimensions !== undefined) {
    for (const vector of embedded.values()) {
      if (vector.length !== dimensions) throw new Error("Embedding dimensions changed inside one Learning Space");
    }
  }

  return enqueueSpaceWrite(space.path, async () => {
    const latest = await readVectorIndex(space, provider);
    const latestById = new Map(latest?.records.map((record) => [record.id, record]) ?? []);
    const records: VectorIndexRecord[] = [];
    for (const memory of memories) {
      const current = latestById.get(memory.id);
      const vector = embedded.get(memory.id) ?? (current?.fingerprint === fingerprint(memory) ? current.vector : undefined);
      if (!vector) throw new Error(`Missing embedding for accepted memory ${memory.id}`);
      if (dimensions !== undefined && vector.length !== dimensions) throw new Error("Embedding dimensions do not match the index");
      records.push({ id: memory.id, fingerprint: fingerprint(memory), vector });
    }
    const result: VectorIndexFile = {
      version: 1,
      spaceId: space.id,
      provider: provider.name,
      model: provider.modelId,
      dimensions: dimensions ?? 0,
      updatedAt: new Date().toISOString(),
      records,
    };
    await writeVectorIndex(space, result);
    return result;
  });
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return Number.isFinite(score) ? score : -1;
}

interface SemanticResult {
  memory: AcceptedMemory;
  score: number;
}

async function semanticSearch(space: SpaceDefinition, memories: readonly AcceptedMemory[], query: string, provider: EmbeddingProvider): Promise<SemanticResult[]> {
  if (memories.length === 0 || !query.trim()) return [];
  const index = await ensureVectorIndex(space, memories, provider);
  const queryVectors = await provider.embed([query]);
  const queryVector = normalizeVector(queryVectors[0]);
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  return index.records
    .map((record) => ({ memory: byId.get(record.id), score: cosineSimilarity(queryVector, record.vector) }))
    .filter((result): result is SemanticResult => Boolean(result.memory) && result.score > -1)
    .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt) || a.memory.id.localeCompare(b.memory.id))
    .slice(0, MAX_SEMANTIC_CANDIDATES);
}

class OptionalTransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = "transformers.js";
  readonly modelId: string;
  private pipelinePromise?: Promise<(texts: string | string[], options: Record<string, unknown>) => Promise<unknown>>;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  private async getPipeline(): Promise<(texts: string | string[], options: Record<string, unknown>) => Promise<unknown>> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        let module: { pipeline?: (task: string, model: string) => Promise<unknown> };
        try {
          const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof module>;
          module = await dynamicImport("@huggingface/transformers");
        } catch {
          throw new Error("Optional @huggingface/transformers package is not installed");
        }
        if (typeof module.pipeline !== "function") throw new Error("Optional Transformers.js package has no pipeline export");
        const extractor = await module.pipeline("feature-extraction", this.modelId);
        if (typeof extractor !== "function") throw new Error("Transformers.js did not create a feature-extraction pipeline");
        return extractor as (texts: string | string[], options: Record<string, unknown>) => Promise<unknown>;
      })();
    }
    return this.pipelinePromise;
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    const output = await extractor(texts.length === 1 ? texts[0] : [...texts], { pooling: "mean", normalize: true });
    return readTransformerEmbeddings(output, texts.length);
  }
}

function readTransformerEmbeddings(output: unknown, count: number): number[][] {
  if (!output || typeof output !== "object") throw new Error("Embedding provider returned no tensor");
  const value = output as { tolist?: () => unknown; data?: ArrayLike<number>; dims?: readonly number[] };
  if (typeof value.tolist === "function") {
    const listed = value.tolist();
    if (Array.isArray(listed) && listed.every((item) => Array.isArray(item))) {
      const vectors = listed.map((item) => normalizeVector(item as number[]));
      if (vectors.length === count) return vectors;
    }
    if (count === 1 && Array.isArray(listed) && listed.every((item) => typeof item === "number")) return [normalizeVector(listed as number[])];
  }
  if (!value.data || !value.dims || value.dims.length < 1) throw new Error("Embedding provider returned an unreadable tensor");
  const data = Array.from(value.data);
  const dimensions = value.dims.length >= 2 ? value.dims[value.dims.length - 1] : data.length / count;
  if (!Number.isInteger(dimensions) || dimensions <= 0 || data.length !== dimensions * count) throw new Error("Embedding provider returned invalid tensor dimensions");
  return Array.from({ length: count }, (_, index) => normalizeVector(data.slice(index * dimensions, (index + 1) * dimensions)));
}

let optionalProvider: OptionalTransformersEmbeddingProvider | undefined;

function defaultEmbeddingProvider(model: string): EmbeddingProvider {
  if (!optionalProvider || optionalProvider.modelId !== model) optionalProvider = new OptionalTransformersEmbeddingProvider(model);
  return optionalProvider;
}

const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_EMBED_TIMEOUT_MS = 30 * 1000;
const OPENROUTER_ERROR_SNIPPET_CHARS = 300;

export interface OpenRouterEmbeddingOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Remote embeddings through the OpenAI-compatible OpenRouter endpoint
 * `POST /v1/embeddings`. Missing credentials or request failures throw so the
 * hybrid backend can fall back to lexical recall, matching the optional local
 * provider's contract.
 */
export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openrouter";
  readonly modelId: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenRouterEmbeddingOptions) {
    this.modelId = options.model;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.baseUrl = (options.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? OPENROUTER_EMBED_TIMEOUT_MS);
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error("OpenRouter embeddings need an API key: set OPENROUTER_API_KEY or memory.retrieval.apiKey");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          input: texts.length === 1 ? texts[0] : [...texts],
          encoding_format: "float",
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, OPENROUTER_ERROR_SNIPPET_CHARS);
        throw new Error(`OpenRouter embeddings request failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      return parseOpenRouterEmbeddings(await response.json(), texts.length);
    } finally {
      clearTimeout(timer);
    }
  }
}

function requireFiniteVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new Error("OpenRouter returned an invalid embedding vector");
  }
  return value as number[];
}

/** Validate an OpenRouter embeddings payload and restore the request order via each entry's index. */
export function parseOpenRouterEmbeddings(payload: unknown, count: number): number[][] {
  if (!payload || typeof payload !== "object") throw new Error("OpenRouter returned an unreadable embeddings response");
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== count) {
    throw new Error(`OpenRouter embeddings response has the wrong batch size (expected ${count})`);
  }
  const entries = data.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("OpenRouter embeddings response has a malformed entry");
    return entry as { index?: unknown; embedding?: unknown };
  });
  const indexed = entries.every((entry) => typeof entry.index === "number" && Number.isInteger(entry.index));
  const vectors = new Array<number[]>(count);
  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position]!;
    const slot = indexed ? (entry.index as number) : position;
    if (slot < 0 || slot >= count || vectors[slot]) throw new Error("OpenRouter embeddings response indices are invalid");
    vectors[slot] = requireFiniteVector(entry.embedding);
  }
  return vectors;
}

function rankById(results: readonly RetrievalResult[] | readonly SemanticResult[]): Map<string, { memory: AcceptedMemory; rank: number }> {
  return new Map(results.map((result, index) => [`${result.memory.spaceId}:${result.memory.id}`, { memory: result.memory, rank: index + 1 }]));
}

export class HybridRetrievalBackend implements RetrievalBackend {
  readonly name: string;
  private readonly lexical: LexicalRetrievalBackend;
  private readonly provider: EmbeddingProvider;
  private readonly rrfK: number;

  constructor(provider: EmbeddingProvider, rrfK = DEFAULT_RRF_K, lexical = new LexicalRetrievalBackend()) {
    this.provider = provider;
    this.name = `hybrid-rrf (${provider.name}; lexical fallback)`;
    this.rrfK = Math.max(1, Math.floor(rrfK));
    this.lexical = lexical;
  }

  async search(spaces: readonly SpaceDefinition[], query: string, limit: number): Promise<RetrievalResult[]> {
    const boundedLimit = Math.max(1, limit);
    const lexicalResults = await this.lexical.search(spaces, query, Math.max(boundedLimit * 4, 20));
    const semanticResults: SemanticResult[] = [];
    try {
      for (const space of spaces) {
        const memories = await readAcceptedMemories(space);
        semanticResults.push(...await semanticSearch(space, memories, query, this.provider));
      }
    } catch {
      // Optional provider, model download, runtime, network, or index
      // corruption must never prevent lexical recall.
      return lexicalResults.slice(0, boundedLimit);
    }

    const lexicalRanks = rankById(lexicalResults);
    const semanticRanks = rankById(semanticResults);
    const allKeys = new Set([...lexicalRanks.keys(), ...semanticRanks.keys()]);
    const fused: RetrievalResult[] = [];
    for (const key of allKeys) {
      const lexical = lexicalRanks.get(key);
      const semantic = semanticRanks.get(key);
      const memory = lexical?.memory ?? semantic?.memory;
      if (!memory) continue;
      const score = (lexical ? 1 / (this.rrfK + lexical.rank) : 0) + (semantic ? 1 / (this.rrfK + semantic.rank) : 0);
      fused.push({ memory, score });
    }
    return fused
      .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt) || a.memory.id.localeCompare(b.memory.id))
      .slice(0, boundedLimit);
  }
}

export function createRetrievalBackend(options: RetrievalBackendOptions = {}): RetrievalBackend {
  const mode = options.mode ?? "auto";
  if (mode === "lexical") return new LexicalRetrievalBackend();
  const kind = options.providerKind ?? "local";
  const provider = options.embeddingProvider ?? (kind === "openrouter"
    ? new OpenRouterEmbeddingProvider({
        model: options.model ?? DEFAULT_OPENROUTER_EMBEDDING_MODEL,
        apiKey: options.embeddingApiKey,
      })
    : defaultEmbeddingProvider(options.model ?? DEFAULT_EMBEDDING_MODEL));
  return new HybridRetrievalBackend(provider, options.rrfK ?? DEFAULT_RRF_K);
}

/** Optional feature detection for environments that want to inspect LanceDB. */
export async function hasOptionalLanceDb(): Promise<boolean> {
  try {
    const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport("@lancedb/lancedb");
    return true;
  } catch {
    return false;
  }
}

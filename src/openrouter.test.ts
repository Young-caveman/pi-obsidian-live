import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSpace } from "./space.js";
import {
  createRetrievalBackend,
  HybridRetrievalBackend,
  OpenRouterEmbeddingProvider,
  parseOpenRouterEmbeddings,
} from "./retrieval.js";
import { effectiveEmbeddingApiKey, effectiveEmbeddingProviderKind, effectiveOptionalEmbeddingModel, parsePiLiveConfig } from "./config.js";

const cleanup: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

interface RecordedRequest {
  authorization?: string;
  body: { model?: unknown; input?: unknown };
}

interface StubOptions {
  status?: number;
  responseBody?: unknown;
  /** Deterministic vectors keyed by a substring of each input text. */
  vectorFor?: (text: string) => number[];
  shuffleIndexes?: boolean;
}

/** Minimal OpenRouter-compatible embeddings stub on an ephemeral local port. */
async function startEmbeddingsStub(options: StubOptions = {}): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: unknown; input?: unknown };
      requests.push({ authorization: request.headers.authorization, body });
      const status = options.status ?? 200;
      if (status !== 200 || !options.vectorFor) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(options.responseBody ?? { error: { message: "stub failure" } }));
        return;
      }
      const input = body.input;
      const texts = Array.isArray(input) ? input.map(String) : [String(input)];
      let entries: Array<{ object: string; embedding: number[]; index?: number }> = texts.map((text) => ({ object: "embedding", embedding: options.vectorFor!(text) }));
      // Keep each embedding paired with its true request position, but scramble the array order.
      const withIndex = entries.map((entry, position) => ({ ...entry, index: position })).reverse();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: withIndex, model: body.model ?? "stub", usage: { prompt_tokens: 1, total_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server has no port");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

function memoryRecord(spaceId: string, id: string, text: string) {
  return {
    id, status: "accepted", spaceId, projectId: "project", sessionId: "session", source: `source:${id}`,
    kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text,
  };
}

describe("OpenRouter embedding provider", () => {
  it("sends bearer auth, model, and batch input; restores order from indices", async () => {
    const stub = await startEmbeddingsStub({
      vectorFor: (text) => (text.includes("alpha") ? [2, 0] : [0, 3]),
      shuffleIndexes: true,
    });
    const provider = new OpenRouterEmbeddingProvider({ model: "openai/text-embedding-3-small", apiKey: "sk-or-test", baseUrl: stub.url });
    const vectors = await provider.embed(["alpha one", "beta two"]);
    // The shuffled index fields must map vectors back to the request order.
    expect(vectors[0]).toEqual([2, 0]);
    expect(vectors[1]).toEqual([0, 3]);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.authorization).toBe("Bearer sk-or-test");
    expect(stub.requests[0]!.body.model).toBe("openai/text-embedding-3-small");
    expect(stub.requests[0]!.body.input).toEqual(["alpha one", "beta two"]);
  });

  it("sends a single string input for one text", async () => {
    const stub = await startEmbeddingsStub({ vectorFor: () => [1, 1] });
    const provider = new OpenRouterEmbeddingProvider({ model: "m", apiKey: "k", baseUrl: stub.url });
    await provider.embed(["only query"]);
    expect(stub.requests[0]!.body.input).toBe("only query");
  });

  it("rejects without an API key before any network call", async () => {
    const stub = await startEmbeddingsStub({ vectorFor: () => [1, 0] });
    const provider = new OpenRouterEmbeddingProvider({ model: "m", baseUrl: stub.url });
    await expect(provider.embed(["text"])).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(stub.requests).toHaveLength(0);
  });

  it("surfaces HTTP errors with the status code", async () => {
    const stub = await startEmbeddingsStub({ status: 401, responseBody: { error: { message: "invalid key" } } });
    const provider = new OpenRouterEmbeddingProvider({ model: "m", apiKey: "bad", baseUrl: stub.url });
    await expect(provider.embed(["text"])).rejects.toThrow(/status 401/);
  });

  it("validates the payload shape", () => {
    expect(() => parseOpenRouterEmbeddings({ data: [{ embedding: [1, 0] }] }, 2)).toThrow(/batch size/);
    expect(() => parseOpenRouterEmbeddings({ data: [{ embedding: [1, Number.NaN] }] }, 1)).toThrow(/invalid embedding vector/);
    expect(() => parseOpenRouterEmbeddings(null, 1)).toThrow(/unreadable/);
    expect(() => parseOpenRouterEmbeddings({}, 1)).toThrow(/batch size/);
    expect(parseOpenRouterEmbeddings({ data: [{ index: 0, embedding: [1, 2] }] }, 1)).toEqual([[1, 2]]);
  });

  it("recalls through hybrid retrieval backed by OpenRouter vectors", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-openrouter-"));
    cleanup.push(root);
    const space = await createSpace(root, "learning");
    const other = await createSpace(root, "other");
    await fs.writeFile(join(space.path, "memories", "raft.json"), JSON.stringify(memoryRecord(space.id, "raft", "Raft commits entries after majority acknowledgement.")));
    await fs.writeFile(join(space.path, "memories", "closure.json"), JSON.stringify(memoryRecord(space.id, "closure", "A closure preserves its lexical environment.")));
    await fs.writeFile(join(other.path, "memories", "leak.json"), JSON.stringify(memoryRecord(other.id, "leak", "Raft memory in a different Learning Space.")));
    const stub = await startEmbeddingsStub({ vectorFor: (text) => (text.includes("majority") || text.includes("consensus quorum") ? [1, 0] : [0, 1]) });

    const backend = new HybridRetrievalBackend(
      new OpenRouterEmbeddingProvider({ model: "openai/text-embedding-3-small", apiKey: "sk-or-test", baseUrl: stub.url }),
    );
    expect(backend.name).toContain("openrouter");
    const results = await backend.search([space], "consensus quorum rules", 5);
    expect(results.map((result) => result.memory.id)).toContain("raft");
    expect(results.map((result) => result.memory.id)).not.toContain("leak");
    // The index persists per Space and is reused on the next search.
    const index = JSON.parse(await fs.readFile(join(space.path, "index", "vectors.json"), "utf8")) as { provider: string; model: string; records: unknown[] };
    expect(index.provider).toBe("openrouter");
    expect(index.model).toBe("openai/text-embedding-3-small");
    expect(index.records).toHaveLength(2);
  });

  it("falls back to lexical recall when OpenRouter returns errors", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-openrouter-fallback-"));
    cleanup.push(root);
    const space = await createSpace(root, "learning");
    await fs.writeFile(join(space.path, "memories", "accepted.json"), JSON.stringify(memoryRecord(space.id, "accepted", "Raft commits entries after majority acknowledgement.")));
    const stub = await startEmbeddingsStub({ status: 429, responseBody: { error: { message: "rate limited" } } });

    const hybrid = new HybridRetrievalBackend(new OpenRouterEmbeddingProvider({ model: "m", apiKey: "k", baseUrl: stub.url }));
    const results = await hybrid.search([space], "How does Raft commit?", 5);
    expect(results.map((result) => result.memory.id)).toEqual(["accepted"]);
  });

  it("builds an OpenRouter-backed backend lazily without credentials", () => {
    const backend = createRetrievalBackend({ mode: "hybrid", providerKind: "openrouter" });
    expect(backend.name).toContain("openrouter");
  });
});

describe("embedding provider configuration", () => {
  it("parses the provider kind, api key, and explicit model", () => {
    const config = parsePiLiveConfig(JSON.stringify({
      memory: { retrieval: { provider: "openrouter", model: "qwen/qwen3-embedding", apiKey: " sk-or-config ", rrfK: 42 } },
    }));
    expect(effectiveEmbeddingProviderKind(config, {})).toBe("openrouter");
    expect(effectiveEmbeddingApiKey(config, {})).toBe("sk-or-config");
    expect(effectiveOptionalEmbeddingModel(config, {})).toBe("qwen/qwen3-embedding");
  });

  it("keeps local defaults and lets environment variables win", () => {
    const config = parsePiLiveConfig(JSON.stringify({ memory: { retrieval: { provider: "local", model: "local/model", apiKey: "config-key" } } }));
    expect(effectiveEmbeddingProviderKind(config, {})).toBe("local");
    expect(effectiveOptionalEmbeddingModel(config, {})).toBe("local/model");
    expect(effectiveEmbeddingApiKey(config, { OPENROUTER_API_KEY: "env-key" })).toBe("env-key");
    expect(effectiveEmbeddingProviderKind(config, { PILIVE_EMBEDDING_PROVIDER: "OpenRouter" })).toBe("openrouter");
    expect(effectiveOptionalEmbeddingModel(config, { PILIVE_EMBEDDING_MODEL: "env/model" })).toBe("env/model");
  });

  it("drops invalid provider kinds and blank keys", () => {
    const config = parsePiLiveConfig(JSON.stringify({ memory: { retrieval: { provider: "lancedb", apiKey: "   " } } }));
    expect(config.memory?.retrieval?.provider).toBeUndefined();
    expect(config.memory?.retrieval?.apiKey).toBeUndefined();
  });
});

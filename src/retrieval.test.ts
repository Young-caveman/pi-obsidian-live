import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSpace } from "./space.js";
import { HybridRetrievalBackend, LexicalRetrievalBackend, lexicalScore, type EmbeddingProvider } from "./retrieval.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("lexical retrieval", () => {
  it("scores matching terms deterministically", () => {
    expect(lexicalScore("closure scope", "A closure retains its lexical scope.")).toBeGreaterThan(0.5);
    expect(lexicalScore("unrelated", "A closure retains its lexical scope.")).toBe(0);
  });

  it("filters by accepted status and mounted Space", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-retrieval-"));
    cleanup.push(root);
    const space = await createSpace(root, "learning");
    const other = await createSpace(root, "other");
    await fs.writeFile(join(space.path, "memories", "accepted.json"), JSON.stringify({
      id: "accepted", status: "accepted", spaceId: space.id, projectId: "project-a", sessionId: "session-a",
      source: "pi-session:session-a#leaf", kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text: "Raft commits entries after majority acknowledgement.",
    }));
    await fs.writeFile(join(space.path, "memories", "candidate.json"), JSON.stringify({
      id: "candidate", status: "candidate", spaceId: space.id, projectId: "project-a", sessionId: "session-a",
      source: "x", kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text: "Raft candidate should not be recalled.",
    }));
    await fs.writeFile(join(other.path, "memories", "other.json"), JSON.stringify({
      id: "other", status: "accepted", spaceId: other.id, projectId: "project-b", sessionId: "session-b",
      source: "x", kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text: "Raft from another space.",
    }));
    const results = await new LexicalRetrievalBackend().search([space], "How does Raft commit?", 5);
    expect(results.map((result) => result.memory.id)).toEqual(["accepted"]);
    expect(results[0]?.memory.projectId).toBe("project-a");
  });
});

interface TestMemory {
  id: string;
  status: "accepted";
  spaceId: string;
  projectId: string;
  sessionId: string;
  source: string;
  kind: string;
  confidence: number;
  createdAt: string;
  text: string;
}

function memory(spaceId: string, id: string, text: string): TestMemory {
  return {
    id, status: "accepted", spaceId, projectId: "project", sessionId: "session", source: `source:${id}`,
    kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text,
  };
}

class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = "fake";
  readonly modelId = "fake-v1";
  calls: string[][] = [];
  fail = false;

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    this.calls.push([...texts]);
    if (this.fail) throw new Error("provider unavailable");
    return texts.map((text) => text.toLocaleLowerCase().includes("closure") || text.toLocaleLowerCase().includes("lifetime") ? [1, 0] : [0, 1]);
  }
}

async function writeMemory(spacePath: string, value: TestMemory): Promise<void> {
  await fs.writeFile(join(spacePath, "memories", `${value.id}.json`), JSON.stringify(value));
}

describe("hybrid retrieval", () => {
  it("fuses BM25 and semantic ranks with RRF and keeps Space isolation", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-hybrid-"));
    cleanup.push(root);
    const space = await createSpace(root, "learning");
    const other = await createSpace(root, "other");
    await writeMemory(space.path, memory(space.id, "lexical", "BM25 finds the exact database term."));
    await writeMemory(space.path, memory(space.id, "semantic", "A closure preserves its environment after the function returns."));
    await writeMemory(other.path, memory(other.id, "leak", "A closure from a different Learning Space."));

    const provider = new FakeEmbeddingProvider();
    const backend = new HybridRetrievalBackend(provider, 1);
    const results = await backend.search([space], "function lifetime", 5);
    expect(results.map((result) => result.memory.id)).toContain("semantic");
    expect(results.map((result) => result.memory.id)).not.toContain("leak");
    expect(results[0]?.score).toBeGreaterThan(0);
    expect(provider.calls).toHaveLength(2);
  });

  it("persists an incremental index and rebuilds a damaged index", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-hybrid-index-"));
    cleanup.push(root);
    const space = await createSpace(root, "learning");
    await writeMemory(space.path, memory(space.id, "one", "A closure preserves lexical scope."));
    const provider = new FakeEmbeddingProvider();
    const backend = new HybridRetrievalBackend(provider);

    await backend.search([space], "closure", 3);
    expect(provider.calls).toHaveLength(2);
    await backend.search([space], "scope", 3);
    expect(provider.calls).toHaveLength(3);

    await fs.writeFile(join(space.path, "memories", "two.json"), JSON.stringify(memory(space.id, "two", "A closure also preserves lifetime state.")));
    await backend.search([space], "lifetime", 3);
    expect(provider.calls).toHaveLength(5);
    const indexPath = join(space.path, "index", "vectors.json");
    const rebuilt = JSON.parse(await fs.readFile(indexPath, "utf8")) as { records: Array<{ id: string }> };
    expect(rebuilt.records.map((record) => record.id).sort()).toEqual(["one", "two"]);

    await fs.writeFile(indexPath, "not-json");
    await backend.search([space], "closure", 3);
    expect(provider.calls).toHaveLength(7);
    const repaired = JSON.parse(await fs.readFile(indexPath, "utf8")) as { version: number; records: Array<{ id: string }> };
    expect(repaired.version).toBe(1);
    expect(repaired.records).toHaveLength(2);
  });

  it("silently falls back to lexical retrieval when the embedding provider fails", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-hybrid-fallback-"));
    cleanup.push(root);
    const space = await createSpace(root, "learning");
    await writeMemory(space.path, memory(space.id, "accepted", "Raft commits entries after majority acknowledgement."));
    const provider = new FakeEmbeddingProvider();
    provider.fail = true;
    const backend = new HybridRetrievalBackend(provider);
    const results = await backend.search([space], "How does Raft commit?", 5);
    expect(results.map((result) => result.memory.id)).toEqual(["accepted"]);
  });
});

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSpace } from "./space.js";
import { LexicalRetrievalBackend, lexicalScore } from "./retrieval.js";

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

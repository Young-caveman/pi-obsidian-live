import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, candidateBelongsToSpace, candidateReviewLine, DEFAULT_AUTO_CAPTURE_IDLE_MS, isLeaseExpired, modeAllowsGeneration, modeAllowsRecall, parseExtractionResponse, prepareJobClaim, projectIdFromCwd, readMemoryMode, withTimeout, visibleConversationText } from "./memory.js";

describe("Pi Live memory", () => {
  it("uses a conservative idle default and bounded job leases", async () => {
    expect(DEFAULT_AUTO_CAPTURE_IDLE_MS).toBeGreaterThanOrEqual(120000);
    const base = {
      id: "job-1", status: "queued" as const, attempts: 0, createdAt: "2026-01-01", updatedAt: "2026-01-01",
      sourceKey: "s#l", sourceText: "long visible text", spaceId: "space", projectId: "project", sessionId: "session", source: "pi-session:s#l",
    };
    const first = prepareJobClaim(base, "worker-a", 1000, 10000, 3);
    expect(first.action).toBe("claim");
    if (first.action !== "claim") throw new Error("expected claim");
    expect(isLeaseExpired(first.job, 5000)).toBe(false);
    expect(prepareJobClaim(first.job, "worker-b", 5000, 10000, 3).action).toBe("skip");
    const recovered = prepareJobClaim(first.job, "worker-b", 12000, 10000, 3);
    expect(recovered.action).toBe("claim");
    if (recovered.action !== "claim") throw new Error("expected stale recovery claim");
    expect(recovered.job.attempts).toBe(2);
    const exhausted = prepareJobClaim({ ...recovered.job, attempts: 3 }, "worker-c", 25000, 10000, 3);
    expect(exhausted.action).toBe("dead");
  });

  it("uses the full project path hash and produces useful review text", async () => {
    expect(projectIdFromCwd("/one/project")).not.toBe(projectIdFromCwd("/two/project"));
    expect(candidateReviewLine({ id: "mem-1", kind: "semantic", confidence: 0.8, text: "A durable memory summary for review." })).toContain("A durable memory summary");
    const validCandidate = {
      id: "mem-1", status: "candidate" as const, spaceId: "space-a", projectId: "project-a",
      sessionId: "session-a", source: "pi-session:session-a#leaf", kind: "semantic",
      confidence: 0.8, createdAt: "2026-01-01T00:00:00Z", text: "A durable memory",
    };
    expect(candidateBelongsToSpace(validCandidate, "space-a")).toBe(true);
    expect(candidateBelongsToSpace(validCandidate, "space-b")).toBe(false);
    expect(candidateBelongsToSpace({ ...validCandidate, confidence: 2 }, "space-a")).toBe(false);
    expect((await withTimeout(new Promise<void>(() => {}), 10)).timedOut).toBe(true);
  });

  it("gates recall and generation independently", () => {
    expect(modeAllowsRecall("off")).toBe(false);
    expect(modeAllowsRecall("read")).toBe(true);
    expect(modeAllowsGeneration("read")).toBe(false);
    expect(modeAllowsGeneration("read-write")).toBe(true);
  });

  it("rebuilds memory mode from session custom entries", () => {
    expect(readMemoryMode([
      { type: "custom", customType: "pi-live-memory", data: { version: 1, mode: "read" } },
      { type: "custom", customType: "pi-live-memory", data: { version: 1, mode: "off" } },
    ], "read-write")).toBe("off");
  });

  it("only uses visible user and assistant text and redacts credentials", () => {
    const text = visibleConversationText([
      { type: "message", message: { role: "user", content: "Teach me closures" } },
      { type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "private chain of thought" },
        { type: "text", text: "A closure retains lexical scope. api_key=super-secret-value" },
        { type: "toolCall", name: "bash", arguments: {} },
      ] } },
      { type: "message", message: { role: "toolResult", content: "do not index me" } },
    ]);
    expect(text).toContain("A closure retains lexical scope");
    expect(text).not.toContain("private chain");
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("do not index me");
  });

  it("parses structured candidates with provenance kept in the prompt", () => {
    const candidates = parseExtractionResponse("```json\n[{\"text\":\"Closures retain lexical scope after the outer call returns.\",\"kind\":\"semantic\",\"confidence\":0.8}]\n```");
    expect(candidates).toEqual([{ text: "Closures retain lexical scope after the outer call returns.", kind: "semantic", confidence: 0.8 }]);
    expect(buildExtractionPrompt({ sourceText: "visible text", projectId: "project-a", source: "pi-session:s#leaf" })).toContain("pi-session:s#leaf");
  });
});

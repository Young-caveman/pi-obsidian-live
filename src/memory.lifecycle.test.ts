import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWrite } from "./storage.js";
import {
  DEFAULT_AUTO_CAPTURE_IDLE_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  registerMemoryFeatures,
  type MemoryCandidate,
} from "./memory.js";
import { createSpace, type SpaceDefinition } from "./space.js";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

interface Runtime {
  branch: Array<Record<string, unknown>>;
  handlers: Map<string, Handler>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  notifications: string[];
  modelComplete: ReturnType<typeof vi.fn>;
  ctx: ExtensionContext;
}

const cleanup: string[] = [];
const originalDataRoot = process.env.PILIVE_DATA_ROOT;
const originalMemoryMode = process.env.PILIVE_MEMORY_MODE;
const originalAutoAccept = process.env.PILIVE_AUTO_ACCEPT_MIN_CONFIDENCE;

afterEach(async () => {
  vi.useRealTimers();
  if (originalDataRoot === undefined) delete process.env.PILIVE_DATA_ROOT;
  else process.env.PILIVE_DATA_ROOT = originalDataRoot;
  if (originalMemoryMode === undefined) delete process.env.PILIVE_MEMORY_MODE;
  else process.env.PILIVE_MEMORY_MODE = originalMemoryMode;
  if (originalAutoAccept === undefined) delete process.env.PILIVE_AUTO_ACCEPT_MIN_CONFIDENCE;
  else process.env.PILIVE_AUTO_ACCEPT_MIN_CONFIDENCE = originalAutoAccept;
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

function candidate(space: SpaceDefinition, id: string, text: string): MemoryCandidate {
  return {
    id,
    status: "candidate",
    spaceId: space.id,
    projectId: "project-test",
    sessionId: "session-test",
    source: "pi-session:session-test#leaf-test",
    kind: "semantic",
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    text,
  };
}

function makeRuntime(root: string, spaceId: string, complete: (...args: unknown[]) => Promise<unknown>): Runtime {
  const branch: Array<Record<string, unknown>> = [
    { type: "custom", customType: "pi-live-space", data: { version: 1, action: "use", spaceId } },
    { type: "custom", customType: "pi-live-memory", data: { version: 1, mode: "read-write" } },
    { type: "message", message: { role: "user", content: "Explain how durable learning memories should be separated from transient conversation output." } },
    { type: "message", message: { role: "assistant", content: "A Learning Space stores accepted durable knowledge while the Obsidian live file remains only a generated reading projection." } },
  ];
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const notifications: string[] = [];
  const modelComplete = vi.fn(complete);
  const ctx = {
    cwd: root,
    hasUI: true,
    isIdle: () => true,
    model: { id: "test-model" },
    modelRegistry: { complete: modelComplete },
    sessionManager: {
      getSessionId: () => "session-test",
      getLeafId: () => "leaf-test",
      getBranch: () => branch,
    },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, definition: { handler: (args: string, context: ExtensionContext) => Promise<void> }) => commands.set(name, definition),
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  registerMemoryFeatures(pi);
  return { branch, handlers, commands, notifications, modelComplete, ctx };
}

async function emit(runtime: Runtime, event: string, payload: unknown = {}): Promise<unknown> {
  const handler = runtime.handlers.get(event);
  if (!handler) throw new Error(`Missing handler: ${event}`);
  return handler(payload, runtime.ctx);
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function waitForInbox(space: SpaceDefinition): Promise<string[]> {
  for (let index = 0; index < 40; index++) {
    const names = (await fs.readdir(join(space.path, "inbox"))).filter((name) => name.endsWith(".json"));
    if (names.length > 0) return names;
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 25));
    await vi.advanceTimersByTimeAsync(25);
    await wait;
  }
  throw new Error("Timed out waiting for memory inbox output");
}

async function waitForJob(space: SpaceDefinition): Promise<{ file: string; job: Record<string, unknown> }> {
  for (let index = 0; index < 40; index++) {
    const names = (await fs.readdir(join(space.path, "jobs"))).filter((name) => name.endsWith(".json"));
    if (names.length > 0) {
      const file = names[0];
      const job = await readJson<Record<string, unknown>>(join(space.path, "jobs", file));
      if (job.status === "running") return { file, job };
    }
    const wait = new Promise<void>((resolve) => setTimeout(resolve, 25));
    await vi.advanceTimersByTimeAsync(25);
    await wait;
  }
  throw new Error("Timed out waiting for running memory job");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

describe("Memory lifecycle", () => {
  it("queues on agent_settled, captures after idle, and supports review/accept/reject", async () => {
    vi.useFakeTimers();
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-lifecycle-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    const space = await createSpace(root, "学习空间");
    const runtime = makeRuntime(root, space.id, async () => ({
      content: [{ type: "text", text: JSON.stringify([{ text: "Accepted records should contain durable learning knowledge and remain isolated by Space.", kind: "semantic", confidence: 0.88 }]) }],
    }));

    await emit(runtime, "session_start");
    await emit(runtime, "agent_settled");
    expect(runtime.modelComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_CAPTURE_IDLE_MS);
    await flushMicrotasks();
    const inbox = await waitForInbox(space);
    const candidateId = inbox[0].replace(/\.json$/, "");

    await runtime.commands.get("memory")!.handler("review", runtime.ctx);
    expect(runtime.notifications.at(-1)).toContain("durable learning knowledge");
    await runtime.commands.get("memory")!.handler(`accept ${candidateId}.json`, runtime.ctx);
    expect((await fs.readdir(join(space.path, "inbox")))).toHaveLength(0);
    expect((await readJson<{ status: string }>(join(space.path, "memories", `${candidateId}.json`))).status).toBe("accepted");

    const rejected = candidate(space, "mem-rejected", "This candidate was explicitly rejected and must not become recallable memory.");
    await atomicWrite(join(space.path, "inbox", `${rejected.id}.json`), JSON.stringify(rejected));
    await runtime.commands.get("memory")!.handler("reject mem-rejected not durable", runtime.ctx);
    expect((await fs.readdir(join(space.path, "inbox")))).toHaveLength(0);
    expect((await readJson<{ status: string; rejectReason?: string }>(join(space.path, "rejected", "mem-rejected.json"))).status).toBe("rejected");
    expect((await readJson<{ rejectReason?: string }>(join(space.path, "rejected", "mem-rejected.json"))).rejectReason).toBe("not durable");

    await emit(runtime, "session_shutdown");
  });

  it("processes manual capture immediately and keeps another Space out of review", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-manual-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    const active = await createSpace(root, "active");
    const other = await createSpace(root, "other");
    const runtime = makeRuntime(root, active.id, async () => ({
      content: [{ type: "text", text: JSON.stringify([{ text: "Manual capture is an explicit path for durable learning extraction.", kind: "procedure", confidence: 0.8 }]) }],
    }));

    await emit(runtime, "session_start");
    await runtime.commands.get("memory")!.handler("capture", runtime.ctx);
    expect(runtime.modelComplete).toHaveBeenCalledTimes(1);
    expect((await fs.readdir(join(active.path, "inbox")))).toHaveLength(1);

    const foreign = candidate(other, "mem-foreign", "Foreign Space memory must never appear in the active Space review list.");
    await atomicWrite(join(other.path, "inbox", `${foreign.id}.json`), JSON.stringify(foreign));
    await runtime.commands.get("memory")!.handler("review", runtime.ctx);
    const review = runtime.notifications.at(-1) ?? "";
    expect(review).toContain("Manual capture");
    expect(review).not.toContain("mem-foreign");
    await runtime.commands.get("memory")!.handler("reject mem-not-found", runtime.ctx);
    expect(runtime.notifications.at(-1)).toContain("Candidate not found in current Space");
  });

  it("serializes concurrent accept/reject mutations and makes repeats idempotent", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-mutations-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    const space = await createSpace(root, "mutations");
    const left = makeRuntime(root, space.id, async () => ({ content: [{ type: "text", text: "[]" }] }));
    const right = makeRuntime(root, space.id, async () => ({ content: [{ type: "text", text: "[]" }] }));

    const accepted = candidate(space, "mem-concurrent", "Concurrent acceptance must leave one consistent accepted record.");
    await atomicWrite(join(space.path, "inbox", `${accepted.id}.json`), JSON.stringify(accepted));
    await Promise.all([
      left.commands.get("memory")!.handler("accept mem-concurrent", left.ctx),
      right.commands.get("memory")!.handler("accept mem-concurrent", right.ctx),
    ]);
    expect((await readJson<{ status: string }>(join(space.path, "memories", "mem-concurrent.json"))).status).toBe("accepted");
    expect((await fs.readdir(join(space.path, "inbox")))).not.toContain("mem-concurrent.json");

    const rejected = candidate(space, "mem-conflict", "A concurrent accept and reject must resolve to one durable state.");
    await atomicWrite(join(space.path, "inbox", `${rejected.id}.json`), JSON.stringify(rejected));
    await Promise.all([
      left.commands.get("memory")!.handler("accept mem-conflict", left.ctx),
      right.commands.get("memory")!.handler("reject mem-conflict race", right.ctx),
    ]);
    const hasAccepted = await fs.stat(join(space.path, "memories", "mem-conflict.json")).then(() => true).catch(() => false);
    const hasRejected = await fs.stat(join(space.path, "rejected", "mem-conflict.json")).then(() => true).catch(() => false);
    expect(Number(hasAccepted) + Number(hasRejected)).toBe(1);
    expect((await fs.readdir(join(space.path, "inbox")))).not.toContain("mem-conflict.json");
  });

  it("rebuilds mounted Space and mode after session tree navigation", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-tree-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "off";
    const first = await createSpace(root, "first");
    const second = await createSpace(root, "second");
    await atomicWrite(join(first.path, "memories", "first.json"), JSON.stringify({
      id: "first", status: "accepted", spaceId: first.id, projectId: "project-a", sessionId: "session-a", source: "first", kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text: "branch unique first memory",
    }));
    await atomicWrite(join(second.path, "memories", "second.json"), JSON.stringify({
      id: "second", status: "accepted", spaceId: second.id, projectId: "project-b", sessionId: "session-b", source: "second", kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text: "branch unique second memory",
    }));
    const runtime = makeRuntime(root, first.id, async () => ({ content: [{ type: "text", text: "[]" }] }));
    await emit(runtime, "session_start");
    runtime.branch.splice(0, runtime.branch.length,
      { type: "custom", customType: "pi-live-space", data: { version: 1, action: "use", spaceId: second.id } },
      { type: "custom", customType: "pi-live-memory", data: { version: 1, mode: "read" } },
    );
    await emit(runtime, "session_tree", { newLeafId: "branch-b", oldLeafId: "branch-a" });
    const result = await emit(runtime, "before_agent_start", { prompt: "second memory", systemPrompt: "base" }) as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toContain("project-b");
    expect(result?.systemPrompt).not.toContain("project-a");
  });

  it("shows memory counts in space and memory status", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-counts-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    const space = await createSpace(root, "counts");
    await atomicWrite(join(space.path, "memories", "one.json"), JSON.stringify({
      id: "one", status: "accepted", spaceId: space.id, projectId: "project", sessionId: "session",
      source: "x", kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text: "accepted memory one",
    }));
    await atomicWrite(join(space.path, "inbox", "pending.json"), JSON.stringify({
      id: "pending", status: "candidate", spaceId: space.id, projectId: "project", sessionId: "session",
      source: "x", kind: "semantic", confidence: 0.9, createdAt: "2026-01-01T00:00:00Z", text: "waiting candidate",
    }));
    const runtime = makeRuntime(root, space.id, async () => ({ content: [{ type: "text", text: "[]" }] }));
    await emit(runtime, "session_start");

    await runtime.commands.get("space")!.handler("status", runtime.ctx);
    expect(runtime.notifications.at(-1)).toContain("Memories: 1 accepted · 1 candidates · 0 rejected");
    await runtime.commands.get("memory")!.handler("status", runtime.ctx);
    expect(runtime.notifications.at(-1)).toContain("Memories: 1 accepted · 1 candidates · 0 rejected");
    await runtime.commands.get("space")!.handler("list", runtime.ctx);
    expect(runtime.notifications.at(-1)).toContain("counts — 1 memories");
  });

  it("accepts candidates in batch and auto-accepts high-confidence ones by threshold", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-autogate-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    process.env.PILIVE_AUTO_ACCEPT_MIN_CONFIDENCE = "0.85";
    const space = await createSpace(root, "gated");
    const runtime = makeRuntime(root, space.id, async () => ({
      content: [{ type: "text", text: JSON.stringify([
        { text: "A high-confidence durable fact about distributed consensus.", kind: "semantic", confidence: 0.95 },
        { text: "A lower-confidence preference that still needs human review.", kind: "preference", confidence: 0.6 },
      ]) }],
    }));
    await emit(runtime, "session_start");
    await runtime.commands.get("memory")!.handler("capture", runtime.ctx);
    // High-confidence item skipped the inbox and went straight to memories.
    const inboxNames = (await fs.readdir(join(space.path, "inbox"))).filter((name) => name.endsWith(".json"));
    const memoryNames = (await fs.readdir(join(space.path, "memories"))).filter((name) => name.endsWith(".json"));
    expect(inboxNames).toHaveLength(1);
    expect(memoryNames).toHaveLength(1);
    expect(runtime.notifications.at(-1)).toContain("auto-accepted 1");
    const autoAccepted = await readJson<{ status: string; confidence: number }>(join(space.path, "memories", memoryNames[0]!));
    expect(autoAccepted.status).toBe("accepted");
    expect(autoAccepted.confidence).toBe(0.95);

    // Batch accept moves the remaining lower-confidence candidate too.
    const lowId = inboxNames[0]!.replace(/\.json$/, "");
    await runtime.commands.get("memory")!.handler(`accept ${lowId} missing-id`, runtime.ctx);
    expect(runtime.notifications.at(-1)).toContain("accepted 1");
    expect(runtime.notifications.at(-1)).toContain("missing-id failed: Candidate not found");
    expect((await fs.readdir(join(space.path, "inbox")))).toHaveLength(0);
    expect((await fs.readdir(join(space.path, "memories")))).toHaveLength(2);
  });

  it("quarantines malformed queue records without blocking status", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-job-schema-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    const space = await createSpace(root, "job schema");
    await fs.writeFile(join(space.path, "jobs", "job-corrupt.json"), JSON.stringify({ id: "job-corrupt", status: "queued", attempts: "not-a-number" }), "utf8");
    const runtime = makeRuntime(root, space.id, async () => ({ content: [{ type: "text", text: "[]" }] }));
    await emit(runtime, "session_start");
    await runtime.commands.get("memory")!.handler("status", runtime.ctx);
    expect(runtime.notifications.some((message) => message.includes("quarantined invalid job"))).toBe(true);
    expect((await fs.readdir(join(space.path, "jobs", "quarantine"))).some((name) => name.startsWith("job-corrupt.json.corrupt-"))).toBe(true);
  });

  it("reports a failed manual capture and recovers the durable job later", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-recovery-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    const space = await createSpace(root, "recovery");
    let shouldFail = true;
    const runtime = makeRuntime(root, space.id, async () => {
      if (shouldFail) throw new Error("provider unavailable");
      return { content: [{ type: "text", text: JSON.stringify([{ text: "Retrying a failed extraction after the provider recovers creates a candidate.", kind: "uncertainty", confidence: 0.7 }]) }] };
    });

    await emit(runtime, "session_start");
    await runtime.commands.get("memory")!.handler("capture", runtime.ctx);
    expect(runtime.notifications.at(-1)).toContain("capture failed");
    const jobFile = (await fs.readdir(join(space.path, "jobs")))[0];
    const jobPath = join(space.path, "jobs", jobFile);
    const failedJob = await readJson<Record<string, unknown>>(jobPath);
    expect(failedJob.status).toBe("failed");
    await atomicWrite(jobPath, JSON.stringify({ ...failedJob, retryAt: 0 }));

    shouldFail = false;
    await runtime.commands.get("memory")!.handler("capture", runtime.ctx);
    expect((await fs.readdir(join(space.path, "inbox")))).toHaveLength(1);
    expect((await readJson<Record<string, unknown>>(jobPath)).status).toBe("completed");
  });

  it("bounds shutdown when a provider ignores abort and leaves a recoverable lease", async () => {
    vi.useFakeTimers();
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-shutdown-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read-write";
    const space = await createSpace(root, "shutdown");
    const runtime = makeRuntime(root, space.id, async () => new Promise(() => {}));

    await emit(runtime, "session_start");
    await emit(runtime, "agent_settled");
    await vi.advanceTimersByTimeAsync(DEFAULT_AUTO_CAPTURE_IDLE_MS);
    await flushMicrotasks();
    await waitForJob(space);
    const shutdown = emit(runtime, "session_shutdown");
    await vi.advanceTimersByTimeAsync(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    await flushMicrotasks();
    await shutdown;
    const jobFile = (await fs.readdir(join(space.path, "jobs")))[0];
    const job = await readJson<{ status: string; lease?: { expiresAt: number } }>(join(space.path, "jobs", jobFile));
    expect(job.status).toBe("running");
    expect(job.lease?.expiresAt).toBeTypeOf("number");
  });

  it("degrades safely when the Space registry is corrupt", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-memory-corrupt-"));
    cleanup.push(root);
    process.env.PILIVE_DATA_ROOT = root;
    process.env.PILIVE_MEMORY_MODE = "read";
    await fs.writeFile(join(root, "registry.json"), "{not-json", "utf8");
    const runtime = makeRuntime(root, "missing", async () => ({ content: [{ type: "text", text: "[]" }] }));

    await expect(emit(runtime, "session_start")).resolves.toBeUndefined();
    await expect(emit(runtime, "before_agent_start", { prompt: "recall" })).resolves.toBeUndefined();
    await runtime.commands.get("memory")!.handler("status", runtime.ctx);
    expect(runtime.notifications.some((message) => message.includes("registry was corrupt and was quarantined"))).toBe(true);
    expect(runtime.notifications.at(-1)).toContain("Pi Live Memory");
  });
});

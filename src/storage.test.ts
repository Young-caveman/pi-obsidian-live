import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWrite, enqueueSpaceWrite } from "./storage.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("Space writer", () => {
  it("serializes concurrent writes and recovers an abandoned lock", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-storage-"));
    cleanup.push(root);
    const lock = join(root, ".pi-live-write.lock");
    await fs.mkdir(lock);
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    await fs.utimes(lock, stale, stale);
    const file = join(root, "counter.json");
    await Promise.all(Array.from({ length: 20 }, () => enqueueSpaceWrite(root, async () => {
      let count = 0;
      try {
        count = JSON.parse(await fs.readFile(file, "utf8")).count;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)));
      await atomicWrite(file, JSON.stringify({ count: count + 1 }));
    })));
    expect(JSON.parse(await fs.readFile(file, "utf8")).count).toBe(20);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

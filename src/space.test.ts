import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createSpace, getSpace, listSpaces, normalizeSpaceId, readActiveSpaceId } from "./space.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("Learning Space", () => {
  it("keeps Chinese names readable while making them path-safe", () => {
    expect(normalizeSpaceId("  线性代数 / 入门  ")).toBe("线性代数-入门");
    expect(normalizeSpaceId(".. / ..")).not.toBe("..");
  });

  it("creates isolated directories and registry entries", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-space-"));
    cleanup.push(root);
    const first = await createSpace(root, "JavaScript Closures");
    const secondPath = join(root, "outside-space");
    const second = await createSpace(root, "Distributed Systems", secondPath);
    expect(first.id).toBe("javascript-closures");
    expect(second.path).toBe(secondPath);
    expect(await getSpace(root, first.id)).toEqual(first);
    expect((await listSpaces(root)).map((space) => space.id)).toEqual(["distributed-systems", "javascript-closures"]);
    expect(await fs.stat(join(first.path, "inbox"))).toBeTruthy();
    expect(await fs.stat(join(second.path, "memories"))).toBeTruthy();
  });

  it("rebuilds session-level state from the active branch only", () => {
    expect(readActiveSpaceId([
      { type: "custom", customType: "pi-live-space", data: { version: 1, action: "use", spaceId: "a" } },
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: "pi-live-space", data: { version: 1, action: "use", spaceId: "b" } },
    ])).toBe("b");
    expect(readActiveSpaceId([
      { type: "custom", customType: "pi-live-space", data: { version: 1, action: "use", spaceId: "a" } },
      { type: "custom", customType: "pi-live-space", data: { version: 1, action: "off" } },
    ])).toBeNull();
  });
});

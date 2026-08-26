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
    expect(second.path).toBe(await fs.realpath(secondPath));
    expect(await getSpace(root, first.id)).toEqual(first);
    expect((await listSpaces(root)).map((space) => space.id)).toEqual(["distributed-systems", "javascript-closures"]);
    expect(await fs.stat(join(first.path, "inbox"))).toBeTruthy();
    expect(await fs.stat(join(second.path, "memories"))).toBeTruthy();
  });

  it("rejects custom paths that are aliases or overlap another Space", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-space-paths-"));
    cleanup.push(root);
    const shared = join(root, "shared");
    await createSpace(root, "first", shared);
    await expect(createSpace(root, "same", shared)).rejects.toThrow(/overlaps existing Space/);
    await expect(createSpace(root, "child", join(shared, "nested"))).rejects.toThrow(/overlaps existing Space/);
    await expect(createSpace(root, "parent", root)).rejects.toThrow(/data root itself/);

    const alias = join(root, "alias");
    await fs.symlink(shared, alias, "dir");
    await expect(createSpace(root, "alias-space", alias)).rejects.toThrow(/symlink/);

    const missing = await createSpace(root, "safe missing", join(root, "new", "nested"));
    expect(missing.path).toBe(join(await fs.realpath(root), "new", "nested"));
  });

  it("quarantines a corrupt registry and reports a diagnostic", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "pi-live-space-registry-"));
    cleanup.push(root);
    await fs.writeFile(join(root, "registry.json"), "{not-json", "utf8");
    const diagnostics: string[] = [];
    expect(await listSpaces(root, (message) => diagnostics.push(message))).toEqual([]);
    expect(diagnostics[0]).toContain("quarantined");
    expect((await fs.readdir(root)).some((name) => name.startsWith("registry.json.corrupt-"))).toBe(true);
    expect((await createSpace(root, "after repair")).id).toBe("after-repair");
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

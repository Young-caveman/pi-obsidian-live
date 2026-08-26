import { describe, expect, it } from "vitest";
import { effectiveDataRoot, effectiveMemoryMode, parsePiLiveConfig, resolvePath } from "./config.js";

describe("Pi Live config", () => {
  it("parses data root and memory settings safely", () => {
    const config = parsePiLiveConfig(JSON.stringify({
      dataRoot: "~/pi-data",
      memory: { mode: "read-write", autoCapture: true, captureIdleMs: 120000, minTextChars: 100, retrievalLimit: 4, maxJobAttempts: 3 },
    }));
    expect(effectiveDataRoot(config, {})).toBe(resolvePath("~/pi-data"));
    expect(effectiveMemoryMode(config, {})).toBe("read-write");
    expect(config.memory?.captureIdleMs).toBe(120000);
    expect(config.memory?.maxJobAttempts).toBe(3);
  });

  it("honors environment overrides without changing the config object", () => {
    const config = parsePiLiveConfig(JSON.stringify({ dataRoot: "/config", memory: { mode: "read" } }));
    expect(effectiveDataRoot(config, { PILIVE_DATA_ROOT: "/env" })).toBe(resolvePath("/env"));
    expect(effectiveMemoryMode(config, { PILIVE_MEMORY_MODE: "on" })).toBe("read-write");
    expect(effectiveMemoryMode(config, { PILIVE_MEMORY_MODE: "off" })).toBe("off");
  });
});

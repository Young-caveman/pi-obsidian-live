import { describe, expect, it } from "vitest";
import { effectiveDataRoot, effectiveEmbeddingModel, effectiveMemoryMode, effectiveRetrievalMode, parsePiLiveConfig, resolvePath } from "./config.js";

describe("Pi Live config", () => {
  it("parses data root and memory settings safely", () => {
    const config = parsePiLiveConfig(JSON.stringify({
      dataRoot: "~/pi-data",
      memory: { mode: "read-write", autoCapture: true, captureIdleMs: 120000, minTextChars: 100, retrievalLimit: 4, maxJobAttempts: 3, retrieval: { mode: "hybrid", model: "local/model", rrfK: 42 } },
    }));
    expect(effectiveDataRoot(config, {})).toBe(resolvePath("~/pi-data"));
    expect(effectiveMemoryMode(config, {})).toBe("read-write");
    expect(config.memory?.captureIdleMs).toBe(120000);
    expect(config.memory?.maxJobAttempts).toBe(3);
    expect(effectiveRetrievalMode(config, {})).toBe("hybrid");
    expect(effectiveEmbeddingModel(config, {})).toBe("local/model");
    expect(config.memory?.retrieval?.rrfK).toBe(42);
  });

  it("honors environment overrides without changing the config object", () => {
    const config = parsePiLiveConfig(JSON.stringify({ dataRoot: "/config", memory: { mode: "read" } }));
    expect(effectiveDataRoot(config, { PILIVE_DATA_ROOT: "/env" })).toBe(resolvePath("/env"));
    expect(effectiveMemoryMode(config, { PILIVE_MEMORY_MODE: "on" })).toBe("read-write");
    expect(effectiveMemoryMode(config, { PILIVE_MEMORY_MODE: "off" })).toBe("off");
    expect(effectiveRetrievalMode(config, { PILIVE_RETRIEVAL_MODE: "lexical" })).toBe("lexical");
    expect(effectiveEmbeddingModel(config, { PILIVE_EMBEDDING_MODEL: "env/model" })).toBe("env/model");
  });
});

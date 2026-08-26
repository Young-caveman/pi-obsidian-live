import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { SpaceDefinition } from "./space.js";
import { resolvePath } from "./config.js";

export interface MemoryProvenance {
  spaceId: string;
  projectId: string;
  sessionId: string;
  source: string;
  kind: string;
  confidence: number;
  createdAt: string;
}

export interface AcceptedMemory extends MemoryProvenance {
  id: string;
  status: "accepted";
  text: string;
}

export interface RetrievalResult {
  memory: AcceptedMemory;
  score: number;
}

export interface RetrievalBackend {
  readonly name: string;
  search(spaces: readonly SpaceDefinition[], query: string, limit: number): Promise<RetrievalResult[]>;
}

const STOP_WORDS = new Set([
  "about", "after", "also", "been", "being", "from", "have", "into", "just", "more", "than", "that", "their", "them", "there", "these", "they", "this", "what", "when", "where", "which", "with", "would", "your",
]);

export function lexicalTokens(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu)?.filter((token) => !STOP_WORDS.has(token)) ?? [];
}

export function lexicalScore(query: string, text: string): number {
  const queryTokens = lexicalTokens(query);
  if (queryTokens.length === 0) return 0;
  const haystack = text.toLocaleLowerCase();
  const tokens = new Set(lexicalTokens(text));
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) score += 1;
    else if (haystack.includes(token)) score += 0.25;
  }
  const phrase = query.trim().toLocaleLowerCase();
  if (phrase.length >= 8 && haystack.includes(phrase)) score += 2;
  return score / queryTokens.length;
}

async function readAcceptedMemories(space: SpaceDefinition): Promise<AcceptedMemory[]> {
  const dir = join(resolvePath(space.path), "memories");
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const memories: AcceptedMemory[] = [];
  for (const name of names.sort()) {
    try {
      const value = JSON.parse(await fs.readFile(join(dir, name), "utf8")) as Partial<AcceptedMemory>;
      if (value.status !== "accepted" || value.spaceId !== space.id || typeof value.text !== "string" || !value.text.trim()) continue;
      if (typeof value.id !== "string" || typeof value.projectId !== "string" || typeof value.sessionId !== "string" || typeof value.source !== "string" || typeof value.kind !== "string" || typeof value.createdAt !== "string") continue;
      memories.push({
        id: value.id,
        status: "accepted",
        spaceId: value.spaceId,
        projectId: value.projectId,
        sessionId: value.sessionId,
        source: value.source,
        kind: value.kind,
        confidence: typeof value.confidence === "number" ? value.confidence : 0,
        createdAt: value.createdAt,
        text: value.text,
      });
    } catch {
      // A corrupt or partially-created derived record must not break recall.
    }
  }
  return memories;
}

export class LexicalRetrievalBackend implements RetrievalBackend {
  readonly name = "lexical";

  async search(spaces: readonly SpaceDefinition[], query: string, limit: number): Promise<RetrievalResult[]> {
    const records = (await Promise.all(spaces.map(readAcceptedMemories))).flat();
    return records
      .map((memory) => ({ memory, score: lexicalScore(query, memory.text) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt) || a.memory.id.localeCompare(b.memory.id))
      .slice(0, Math.max(1, limit));
  }
}

/**
 * Feature detection hook for a future embedded LanceDB implementation.
 * It deliberately does not import or call an unverified LanceDB API. The
 * lexical backend remains the safe fallback when the optional package is not
 * installed or native bindings are unavailable.
 */
export async function hasOptionalLanceDb(): Promise<boolean> {
  try {
    const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    await dynamicImport("lancedb");
    return true;
  } catch {
    return false;
  }
}

export function createRetrievalBackend(): RetrievalBackend {
  return new LexicalRetrievalBackend();
}


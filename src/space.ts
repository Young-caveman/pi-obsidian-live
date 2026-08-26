import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { resolvePath } from "./config.js";
import { atomicWrite, enqueueSpaceWrite } from "./storage.js";

export const SPACE_ENTRY_TYPE = "pi-live-space";

export interface SpaceDefinition {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceRegistry {
  version: 1;
  spaces: Record<string, SpaceDefinition>;
}

export interface SpaceSessionAction {
  version: 1;
  action: "use" | "off";
  spaceId?: string;
  at?: string;
}

export const SPACE_DIRS = ["memories", "inbox", "rejected", "jobs", "index"] as const;

export function normalizeSpaceId(input: string): string {
  const normalized = input.normalize("NFKC").trim().toLocaleLowerCase();
  const id = normalized
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!id || id === "." || id === "..") throw new Error("Space name must contain at least one letter or number");
  return Array.from(id).slice(0, 80).join("");
}

export function defaultSpacePath(dataRoot: string, id: string): string {
  return join(resolvePath(dataRoot), "spaces", normalizeSpaceId(id));
}

export function emptyRegistry(): SpaceRegistry {
  return { version: 1, spaces: {} };
}

export function parseRegistry(raw: string): SpaceRegistry {
  const value = JSON.parse(raw) as Partial<SpaceRegistry>;
  if (value.version !== 1 || !value.spaces || typeof value.spaces !== "object") {
    throw new Error("Invalid Pi Live Space registry");
  }
  const spaces: Record<string, SpaceDefinition> = {};
  for (const [id, valueForSpace] of Object.entries(value.spaces)) {
    if (!valueForSpace || typeof valueForSpace !== "object") continue;
    const candidate = valueForSpace as Partial<SpaceDefinition>;
    if (typeof candidate.path !== "string" || typeof candidate.name !== "string") continue;
    spaces[id] = {
      id,
      name: candidate.name,
      path: resolvePath(candidate.path),
      createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
      updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
    };
  }
  return { version: 1, spaces };
}

export async function loadRegistry(dataRoot: string): Promise<SpaceRegistry> {
  const file = join(resolvePath(dataRoot), "registry.json");
  try {
    return parseRegistry(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

export async function saveRegistry(dataRoot: string, registry: SpaceRegistry): Promise<void> {
  const file = join(resolvePath(dataRoot), "registry.json");
  await atomicWrite(file, JSON.stringify(registry, null, 2) + "\n");
}

export async function ensureSpaceDirs(spacePath: string): Promise<void> {
  await Promise.all([
    fs.mkdir(resolvePath(spacePath), { recursive: true }),
    ...SPACE_DIRS.map((dir) => fs.mkdir(join(resolvePath(spacePath), dir), { recursive: true })),
  ]);
}

export async function createSpace(dataRoot: string, name: string, customPath?: string): Promise<SpaceDefinition> {
  const id = normalizeSpaceId(name);
  return enqueueSpaceWrite(resolvePath(dataRoot), async () => {
    const registry = await loadRegistry(dataRoot);
    if (registry.spaces[id]) throw new Error(`Space already exists: ${id}`);
    const now = new Date().toISOString();
    const definition: SpaceDefinition = {
      id,
      name: name.trim(),
      path: resolvePath(customPath?.trim() || defaultSpacePath(dataRoot, id)),
      createdAt: now,
      updatedAt: now,
    };
    await ensureSpaceDirs(definition.path);
    registry.spaces[id] = definition;
    await saveRegistry(dataRoot, registry);
    return definition;
  });
}

export async function listSpaces(dataRoot: string): Promise<SpaceDefinition[]> {
  const registry = await loadRegistry(dataRoot);
  return Object.values(registry.spaces).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getSpace(dataRoot: string, id: string): Promise<SpaceDefinition | undefined> {
  const registry = await loadRegistry(dataRoot);
  return registry.spaces[normalizeSpaceId(id)];
}

export function readActiveSpaceId(entries: readonly { type?: string; customType?: string; data?: unknown }[]): string | null {
  let active: string | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SPACE_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Partial<SpaceSessionAction>;
    if (data.version !== 1) continue;
    if (data.action === "off") active = null;
    if (data.action === "use" && typeof data.spaceId === "string") active = data.spaceId;
  }
  return active;
}

export function describeSpace(space: SpaceDefinition | undefined, active: boolean): string {
  if (!space) return "(unknown space)";
  return `${space.id}${active ? " *" : ""} — ${basename(space.path)}`;
}

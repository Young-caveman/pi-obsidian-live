import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
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
export type RegistryDiagnostic = (message: string) => void;

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
  const spaces: Record<string, SpaceDefinition> = Object.create(null) as Record<string, SpaceDefinition>;
  for (const [id, valueForSpace] of Object.entries(value.spaces)) {
    if (!/^[\p{L}\p{N}._-]+$/u.test(id) || normalizeSpaceId(id) !== id) throw new Error("Invalid Pi Live Space registry");
    if (!valueForSpace || typeof valueForSpace !== "object") throw new Error("Invalid Pi Live Space registry");
    const candidate = valueForSpace as Partial<SpaceDefinition>;
    if (typeof candidate.path !== "string" || !candidate.path.trim() || typeof candidate.name !== "string" || !candidate.name.trim()) {
      throw new Error("Invalid Pi Live Space registry");
    }
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

async function quarantineRegistry(file: string, error: unknown, diagnostic?: RegistryDiagnostic): Promise<SpaceRegistry> {
  const target = `${file}.corrupt-${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fs.rename(file, target);
  } catch (quarantineError) {
    const detail = quarantineError instanceof Error ? quarantineError.message : String(quarantineError);
    diagnostic?.(`Pi Live: Space registry is corrupt and could not be quarantined (${detail}); memory operations are disabled.`);
    throw error;
  }
  diagnostic?.(`Pi Live: Space registry was corrupt and was quarantined at ${target}; starting with an empty registry.`);
  return emptyRegistry();
}

export async function loadRegistry(dataRoot: string, diagnostic?: RegistryDiagnostic): Promise<SpaceRegistry> {
  const file = join(resolvePath(dataRoot), "registry.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    try {
      return parseRegistry(raw);
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message === "Invalid Pi Live Space registry")) {
        return quarantineRegistry(file, error, diagnostic);
      }
      throw error;
    }
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

async function canonicalPath(input: string, rejectSymlinks: boolean): Promise<string> {
  const lexical = resolvePath(input);
  const missing: string[] = [];
  let cursor = lexical;
  for (;;) {
    try {
      const linkStat = await fs.lstat(cursor);
      if (linkStat.isSymbolicLink()) {
        if (rejectSymlinks) throw new Error(`Space path cannot contain a symlink: ${cursor}`);
        const targetStat = await fs.stat(cursor);
        if (!targetStat.isDirectory()) throw new Error(`Space path is not a directory: ${cursor}`);
      } else if (!linkStat.isDirectory()) {
        throw new Error(`Space path is not a directory: ${cursor}`);
      }
      const real = await fs.realpath(cursor);
      return join(real, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const within = (parent: string, child: string): boolean => {
    const distance = relative(parent, child);
    return distance === "" || (!distance.startsWith(`..${sep}`) && distance !== ".." && !isAbsolute(distance));
  };
  return within(left, right) || within(right, left);
}

async function validateSpacePath(
  dataRoot: string,
  candidatePath: string,
  customPath: boolean,
  registry: SpaceRegistry,
): Promise<string> {
  const root = await canonicalPath(dataRoot, false);
  const canonical = await canonicalPath(candidatePath, customPath);
  if (customPath && canonical === root) {
    throw new Error("Space path cannot be the data root itself");
  }
  for (const existing of Object.values(registry.spaces)) {
    const existingPath = await canonicalPath(existing.path, true);
    if (pathsOverlap(canonical, existingPath)) {
      throw new Error(`Space path overlaps existing Space ${existing.id}: ${existingPath}`);
    }
  }
  return canonical;
}

export async function createSpace(dataRoot: string, name: string, customPath?: string, diagnostic?: RegistryDiagnostic): Promise<SpaceDefinition> {
  const id = normalizeSpaceId(name);
  return enqueueSpaceWrite(resolvePath(dataRoot), async () => {
    const registry = await loadRegistry(dataRoot, diagnostic);
    if (registry.spaces[id]) throw new Error(`Space already exists: ${id}`);
    const now = new Date().toISOString();
    const requestedPath = customPath?.trim() || defaultSpacePath(dataRoot, id);
    const path = await validateSpacePath(dataRoot, requestedPath, Boolean(customPath?.trim()), registry);
    const definition: SpaceDefinition = {
      id,
      name: name.trim(),
      path,
      createdAt: now,
      updatedAt: now,
    };
    await ensureSpaceDirs(definition.path);
    registry.spaces[id] = definition;
    await saveRegistry(dataRoot, registry);
    return definition;
  });
}

export async function listSpaces(dataRoot: string, diagnostic?: RegistryDiagnostic): Promise<SpaceDefinition[]> {
  const registry = await loadRegistry(dataRoot, diagnostic);
  return Object.values(registry.spaces).sort((a, b) => a.id.localeCompare(b.id));
}

export async function getSpace(dataRoot: string, id: string, diagnostic?: RegistryDiagnostic): Promise<SpaceDefinition | undefined> {
  const registry = await loadRegistry(dataRoot, diagnostic);
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

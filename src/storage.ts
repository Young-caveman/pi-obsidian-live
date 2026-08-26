import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Write a file through a same-directory temporary file and atomic rename. */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.pi-live-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Serialize writes for one logical Space within this Pi process. */
const queues = new Map<string, Promise<void>>();

export function enqueueSpaceWrite<T>(spacePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(spacePath) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => withSpaceFileLock(spacePath, operation));
  const settled = current.then(() => undefined, () => undefined);
  queues.set(spacePath, settled);
  void settled.finally(() => {
    if (queues.get(spacePath) === settled) queues.delete(spacePath);
  });
  return current;
}

/**
 * Best-effort cross-process lock for parallel Pi processes targeting one Space.
 * The in-process promise queue above handles normal ordering; this directory
 * lock prevents two processes from updating the same JSON record at once.
 */
async function withSpaceFileLock<T>(spacePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(spacePath, ".pi-live-write.lock");
  await fs.mkdir(spacePath, { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      try {
        await fs.writeFile(join(lockPath, "owner"), `${process.pid}\n`, "utf8");
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        // A crashed process cannot clean up. Five minutes is deliberately
        // longer than normal JSON writes and model requests are not performed
        // while a write lock is needed by the caller's critical section.
        if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

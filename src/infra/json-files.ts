import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WriteJsonAtomicOptions = {
  mode?: number;
  trailingNewline?: boolean;
  ensureDirMode?: number;
};

export function createAsyncLock() {
  let pending = Promise.resolve();
  return async function withLock<T>(task: () => Promise<T>): Promise<T> {
    const current = pending.then(task, task);
    pending = current.then(
      () => undefined,
      () => undefined,
    );
    return await current;
  };
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  const raw = await fs.readFile(filePath, "utf-8").catch(() => null);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as T;
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  opts: WriteJsonAtomicOptions = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: opts.ensureDirMode ?? 0o755,
  });
  const payload = JSON.stringify(value, null, 2) + (opts.trailingNewline ? "\n" : "");
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, payload, { mode: opts.mode ?? 0o644 });
  await fs.rename(tempPath, filePath);
}

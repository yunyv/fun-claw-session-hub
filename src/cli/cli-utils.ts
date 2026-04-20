import type { RuntimeLike } from "../runtime.js";

export async function runCommandWithRuntime<T>(runtime: RuntimeLike, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    runtime.error(error);
    throw error;
  }
}

import os from "node:os";
import path from "node:path";
import { WORKER_DEFAULT_STATE_DIR_NAME } from "../contracts/index.js";

export function resolveFunclawWorkerStateDir(explicitPath?: string): string {
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return path.resolve(explicitPath);
  }
  return path.join(os.homedir(), ".openclaw", WORKER_DEFAULT_STATE_DIR_NAME);
}


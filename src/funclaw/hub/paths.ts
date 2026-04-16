import os from "node:os";
import path from "node:path";
import { HUB_DEFAULT_DATA_DIR_NAME } from "../contracts/index.js";

export function resolveFunclawHubDataDir(explicitPath?: string): string {
  if (typeof explicitPath === "string" && explicitPath.trim()) {
    return path.resolve(explicitPath);
  }
  return path.join(os.homedir(), ".openclaw", HUB_DEFAULT_DATA_DIR_NAME);
}

export function resolveHubSessionsPath(dataDir: string): string {
  return path.join(dataDir, "sessions.json");
}

export function resolveHubRequestsPath(dataDir: string): string {
  return path.join(dataDir, "requests.jsonl");
}

export function resolveHubArtifactsIndexPath(dataDir: string): string {
  return path.join(dataDir, "artifacts.json");
}

export function resolveHubArtifactsDir(dataDir: string): string {
  return path.join(dataDir, "artifacts");
}


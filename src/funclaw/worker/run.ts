import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../../version.js";

const workerRootDir = fileURLToPath(new URL("./", import.meta.url));
const workerBinaryPath = path.join(workerRootDir, "bin", process.platform === "win32" ? "go-worker.exe" : "go-worker");

export type StartFunclawWorkerOptions = {
  hubUrl: string;
  hubToken?: string;
  workerId: string;
  capabilities?: string[];
  gatewayBaseUrl?: string;
  gatewayToken?: string;
  gatewayWsUrl?: string;
  stdio?: "inherit" | "pipe" | "ignore";
};

type RunningFunclawWorker = {
  pid: number | undefined;
  close(): Promise<void>;
};

async function buildBundledGoWorker() {
  // 每次启动前都本地构建，确保跑的是当前仓库里的 Go 源码，不会误用旧二进制。
  await fs.mkdir(path.dirname(workerBinaryPath), { recursive: true });
  await runGoCommand(["build", "-o", workerBinaryPath, "./cmd/go-worker"]);
  return workerBinaryPath;
}

async function runGoCommand(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("go", args, {
      cwd: workerRootDir,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`go ${args.join(" ")} failed with code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

function buildWorkerArgs(opts: StartFunclawWorkerOptions) {
  const args = [
    "--hub-url",
    opts.hubUrl,
    "--worker-id",
    opts.workerId,
    "--gateway-url",
    opts.gatewayBaseUrl ?? "http://127.0.0.1:18789",
    "--gateway-ws-url",
    opts.gatewayWsUrl ?? "ws://127.0.0.1:18789",
    "--version",
    VERSION,
  ];
  if (opts.hubToken) {
    args.push("--hub-token", opts.hubToken);
  }
  if (opts.gatewayToken) {
    args.push("--gateway-token", opts.gatewayToken);
  }
  if (opts.capabilities?.length) {
    args.push("--capabilities", opts.capabilities.join(","));
  }
  return args;
}

async function waitForChildSpawn(child: ChildProcess) {
  await Promise.race([
    once(child, "spawn"),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(`worker exited before startup: code=${String(code)} signal=${String(signal)}`);
    }),
    once(child, "error").then(([error]) => {
      throw error;
    }),
  ]);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timer);
  }
}

export async function startFunclawWorker(opts: StartFunclawWorkerOptions): Promise<RunningFunclawWorker> {
  const binaryPath = await buildBundledGoWorker();
  const child = spawn(binaryPath, buildWorkerArgs(opts), {
    cwd: workerRootDir,
    stdio: opts.stdio ?? "inherit",
    env: process.env,
  });

  await waitForChildSpawn(child);

  return {
    pid: child.pid,
    async close() {
      await stopChild(child);
    },
  };
}

import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { startFunclawHubServer } from "../../funclaw/hub/server.js";
import { startFunclawWorker } from "../../funclaw/worker/run.js";

type FunclawHubRunOpts = {
  host?: string;
  port?: string;
  token?: string;
  dataDir?: string;
  publicBaseUrl?: string;
};

type FunclawWorkerRunOpts = {
  hubUrl?: string;
  hubToken?: string;
  workerId?: string;
  gatewayUrl?: string;
  gatewayWsUrl?: string;
  gatewayToken?: string;
  capabilities?: string;
};

function resolvePort(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return Math.floor(parsed);
}

async function waitForever() {
  await new Promise<void>(() => undefined);
}

export function registerFunclawCli(program: Command) {
  const funclaw = program
    .command("funclaw")
    .description("Run FunClaw Hub / Worker services")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw funclaw hub run --token \"$FUNCLAW_HUB_TOKEN\"", "Run the FunClaw Session Hub."],
          [
            "openclaw funclaw worker run --hub-url ws://47.118.27.59:31880/ws --hub-token \"$FUNCLAW_HUB_TOKEN\" --gateway-token \"$OPENCLAW_GATEWAY_TOKEN\"",
            "Run the OpenClaw-side FunClaw worker.",
          ],
        ])}\n`,
    );

  funclaw
    .command("hub")
    .description("Run the FunClaw Session Hub")
    .command("run")
    .description("Run the FunClaw Hub in the foreground")
    .option("--host <host>", "Bind host", "0.0.0.0")
    .option("--port <port>", "Bind port", "31880")
    .option("--token <token>", "Bearer token for Hub HTTP/WS auth", process.env.FUNCLAW_HUB_TOKEN)
    .option("--data-dir <path>", "Hub data directory")
    .option("--public-base-url <url>", "Public base URL for artifact download links")
    .action(async (opts: FunclawHubRunOpts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await startFunclawHubServer({
          host: opts.host,
          port: resolvePort(opts.port, 31_880),
          token: opts.token,
          dataDir: opts.dataDir,
          publicBaseUrl: opts.publicBaseUrl,
        });
        await waitForever();
      });
    });

  funclaw
    .command("worker")
    .description("Run the OpenClaw-side FunClaw worker")
    .command("run")
    .description("Run the worker in the foreground")
    .requiredOption("--hub-url <url>", "Hub WebSocket URL", process.env.FUNCLAW_HUB_URL)
    .requiredOption("--hub-token <token>", "Hub auth token", process.env.FUNCLAW_HUB_TOKEN)
    .requiredOption("--worker-id <id>", "Stable worker id", process.env.FUNCLAW_WORKER_ID)
    .option("--gateway-url <url>", "OpenClaw Gateway HTTP base URL", "http://127.0.0.1:18789")
    .option("--gateway-ws-url <url>", "OpenClaw Gateway WS URL", "ws://127.0.0.1:18789")
    .option(
      "--gateway-token <token>",
      "OpenClaw Gateway bearer token",
      process.env.OPENCLAW_GATEWAY_TOKEN,
    )
    .option(
      "--capabilities <csv>",
      "Comma-separated worker capabilities",
      "responses.create,agent,session.history.get,node.invoke",
    )
    .action(async (opts: FunclawWorkerRunOpts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await startFunclawWorker({
          hubUrl: String(opts.hubUrl),
          hubToken: opts.hubToken,
          workerId: String(opts.workerId),
          gatewayBaseUrl: opts.gatewayUrl,
          gatewayWsUrl: opts.gatewayWsUrl,
          gatewayToken: opts.gatewayToken,
          capabilities: String(opts.capabilities ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean),
        });
        await waitForever();
      });
    });
}

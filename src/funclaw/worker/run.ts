import os from "node:os";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import {
  type ArtifactDescriptor,
  type ErrorShape,
  type TaskAssignedPayload,
  validateTaskAssignedPayload,
} from "../contracts/index.js";
import { FunclawHubClient } from "./hub-client.js";
import { WorkerOpenClawClient } from "./openclaw-client.js";

export type StartFunclawWorkerOptions = {
  hubUrl: string;
  hubToken?: string;
  workerId: string;
  capabilities?: string[];
  gatewayBaseUrl?: string;
  gatewayToken?: string;
  gatewayWsUrl?: string;
};

function errorShape(error: unknown): ErrorShape {
  return {
    code: "WORKER_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function startFunclawWorker(opts: StartFunclawWorkerOptions) {
  const openclaw = new WorkerOpenClawClient({
    gatewayBaseUrl: opts.gatewayBaseUrl ?? "http://127.0.0.1:18789",
    gatewayToken: opts.gatewayToken,
    gatewayWsUrl: opts.gatewayWsUrl ?? "ws://127.0.0.1:18789",
  });

  const hub = new FunclawHubClient({
    url: opts.hubUrl,
    token: opts.hubToken,
    workerId: opts.workerId,
    hostname: os.hostname(),
    version: VERSION,
    capabilities: opts.capabilities ?? ["responses.create", "session.history.get", "node.invoke"],
    onTaskAssigned: async (payload) => {
      if (!validateTaskAssignedPayload(payload)) {
        throw new Error("Invalid task.assigned payload");
      }
      const task = payload as TaskAssignedPayload;
      await hub.sendAccepted(task.request_id);
      try {
        let result: unknown;
        let artifacts: ArtifactDescriptor[] = [];
        if (task.action === "responses.create") {
          result = await openclaw.createResponse(task.input, task.openclaw_session_key);
        } else if (task.action === "session.history.get") {
          result = await openclaw.getSessionHistory(
            task.openclaw_session_key,
            (task.input as Record<string, unknown>) ?? {},
          );
        } else if (task.action === "node.invoke") {
          const raw = await openclaw.invokeNode(task.input);
          const normalized = openclaw.normalizeNodeArtifacts(raw);
          result = normalized.result;
          artifacts = [];
          for (const artifact of normalized.artifacts) {
            const descriptor = await hub.registerArtifact({
              requestId: task.request_id,
              kind: artifact.kind,
              filename: artifact.filename,
              mimeType: artifact.mimeType,
              contentBase64: artifact.contentBase64,
              meta: artifact.meta,
            });
            artifacts.push(descriptor);
          }
        } else {
          throw new Error("Unsupported task action");
        }
        await hub.sendCompleted(task.request_id, result, artifacts);
      } catch (error) {
        await hub.sendFailed(task.request_id, errorShape(error));
      }
    },
  });

  await hub.start();
  defaultRuntime.log(
    `FunClaw Worker connected to ${opts.hubUrl} as ${opts.workerId} -> ${opts.gatewayBaseUrl ?? "http://127.0.0.1:18789"}`,
  );

  return {
    async close() {
      await hub.stop();
    },
  };
}

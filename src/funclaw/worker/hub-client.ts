import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { rawDataToString } from "../../infra/ws.js";
import {
  HUB_DEFAULT_CONNECT_TIMEOUT_MS,
  HUB_DEFAULT_HEARTBEAT_INTERVAL_MS,
  HUB_PROTOCOL_VERSION,
  buildHubHelloOk,
  type ArtifactDescriptor,
  type ErrorShape,
  type HubConnectParams,
  type HubEventFrame,
  type HubHelloOk,
  type HubRequestFrame,
  validateHubEventFrame,
  validateHubHelloOk,
  validateHubResponseFrame,
} from "../contracts/index.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout | null;
};

export type FunclawHubClientOptions = {
  url: string;
  token?: string;
  workerId: string;
  hostname: string;
  version: string;
  capabilities: string[];
  onTaskAssigned: (payload: unknown) => Promise<void>;
};

export class FunclawHubClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private challengeNonce: string | null = null;
  private pendingConnectedResolve: (() => void) | null = null;

  constructor(private readonly opts: FunclawHubClientOptions) {}

  async start() {
    await this.connect();
  }

  async stop() {
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.ws?.close(1000, "worker shutdown");
  }

  async sendHeartbeat() {
    await this.request("worker.heartbeat", {
      worker_id: this.opts.workerId,
      ts: new Date().toISOString(),
    });
  }

  async sendAccepted(requestId: string) {
    await this.request("task.accepted", {
      request_id: requestId,
      accepted_at: new Date().toISOString(),
    });
  }

  async sendOutput(requestId: string, outputIndex: number, output: unknown) {
    await this.request("task.output", {
      request_id: requestId,
      output_index: outputIndex,
      output,
      emitted_at: new Date().toISOString(),
    });
  }

  async registerArtifact(params: {
    requestId: string;
    kind: ArtifactDescriptor["kind"];
    filename: string;
    mimeType: string;
    contentBase64: string;
    meta?: Record<string, unknown>;
  }): Promise<ArtifactDescriptor> {
    const payload = await this.request("artifact.register", {
      request_id: params.requestId,
      artifact: {
        kind: params.kind,
        filename: params.filename,
        mime_type: params.mimeType,
        content_base64: params.contentBase64,
        meta: params.meta,
      },
    });
    return payload as ArtifactDescriptor;
  }

  async sendCompleted(requestId: string, result: unknown, artifacts: ArtifactDescriptor[]) {
    await this.request("task.completed", {
      request_id: requestId,
      completed_at: new Date().toISOString(),
      result,
      artifacts,
    });
  }

  async sendFailed(requestId: string, error: ErrorShape) {
    await this.request("task.failed", {
      request_id: requestId,
      failed_at: new Date().toISOString(),
      error,
    });
  }

  private async connect() {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      let opened = false;
      this.connectTimer = setTimeout(() => {
        ws.close(1008, "hub connect timeout");
        reject(new Error("Timed out waiting for Hub connect challenge"));
      }, HUB_DEFAULT_CONNECT_TIMEOUT_MS);

      ws.once("open", () => {
        opened = true;
        this.pendingConnectedResolve = resolve;
      });
      ws.once("error", (error) => {
        if (!opened) {
          reject(error);
        }
      });
      ws.on("message", async (raw) => {
        await this.onMessage(rawDataToString(raw));
      });
      ws.on("close", () => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        if (!this.closed) {
          setTimeout(() => {
            void this.connect().catch(() => undefined);
          }, 1000);
        }
      });
    });
  }

  private async onMessage(raw: string) {
    const parsed = JSON.parse(raw) as unknown;
    if (validateHubEventFrame(parsed)) {
      const event = parsed as HubEventFrame;
      if (event.event === "connect.challenge") {
        const nonce = (event.payload as { nonce?: string } | undefined)?.nonce;
        if (!nonce) {
          throw new Error("Hub connect challenge missing nonce");
        }
        this.challengeNonce = nonce;
        await this.sendConnect();
        return;
      }
      if (event.event === "task.assigned") {
        await this.opts.onTaskAssigned(event.payload);
        return;
      }
      return;
    }
    if (!validateHubResponseFrame(parsed)) {
      return;
    }
    const response = parsed as {
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: { code?: string; message?: string; details?: unknown };
    };
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (!response.ok) {
      pending.reject(
        new Error(
          response.error?.message ??
            response.error?.code ??
            "Hub request failed without error details",
        ),
      );
      return;
    }
    if (response.payload && !this.heartbeatTimer) {
      const maybeHello = response.payload as HubHelloOk;
      if (validateHubHelloOk(maybeHello) && maybeHello.type === buildHubHelloOk("x", "x").type) {
        if (this.connectTimer) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.pendingConnectedResolve?.();
        this.pendingConnectedResolve = null;
        const intervalMs =
          maybeHello.policy?.heartbeatIntervalMs || HUB_DEFAULT_HEARTBEAT_INTERVAL_MS;
        this.heartbeatTimer = setInterval(() => {
          void this.sendHeartbeat().catch(() => undefined);
        }, intervalMs);
      }
    }
    pending.resolve(response.payload);
  }

  private async sendConnect() {
    const params: HubConnectParams = {
      minProtocol: HUB_PROTOCOL_VERSION,
      maxProtocol: HUB_PROTOCOL_VERSION,
      client: {
        id: "funclaw-worker",
        version: this.opts.version,
        platform: process.platform,
        mode: "worker",
      },
      role: "worker",
      auth: this.opts.token ? { token: this.opts.token } : undefined,
      nonce: this.challengeNonce ?? "",
      worker: {
        worker_id: this.opts.workerId,
        hostname: this.opts.hostname,
        version: this.opts.version,
        capabilities: this.opts.capabilities,
      },
    };
    await this.request("connect", params);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Hub socket is not connected");
    }
    const id = randomUUID();
    const frame: HubRequestFrame = { type: "req", id, method, params };
    const payload = JSON.stringify(frame);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hub request timeout for ${method}`));
      }, HUB_DEFAULT_CONNECT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.ws.send(payload);
    return await promise;
  }
}

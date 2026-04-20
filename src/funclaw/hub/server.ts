import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { readJsonBodyWithLimit } from "../../infra/http-body.js";
import { rawDataToString } from "../../infra/ws.js";
import { defaultRuntime } from "../../runtime.js";
import { sendJson, sendMethodNotAllowed, sendText } from "../../gateway/http-common.js";
import { VERSION } from "../../version.js";
import {
  HUB_DEFAULT_CONNECT_TIMEOUT_MS,
  HUB_DEFAULT_HOST,
  HUB_DEFAULT_MAX_BODY_BYTES,
  HUB_DEFAULT_PORT,
  HUB_DEFAULT_REQUEST_TIMEOUT_MS,
  buildHubHelloOk,
  type ArtifactRegisterParams,
  type CreateSessionBody,
  type ErrorShape,
  type HubConnectParams,
  type HubRequestFrame,
  type PostSessionMessageBody,
  type RequestRecord,
  type SessionRouteRecord,
  validateArtifactRegisterParams,
  validateAwaitRequestBody,
  validateCreateSessionBody,
  validateHubConnectParams,
  validateHubRequestFrame,
  validatePostSessionMessageBody,
  validateTaskAcceptedPayload,
  validateTaskCompletedPayload,
  validateTaskFailedPayload,
  validateTaskOutputPayload,
  validateWorkerHeartbeatPayload,
} from "../contracts/index.js";
import { resolveFunclawHubDataDir } from "./paths.js";
import { type ConnectedWorkerState, FunclawHubStore } from "./store.js";

type HubClientState = {
  connId: string;
  socket: WebSocket;
  connected: boolean;
  challengeNonce: string;
  role: "worker" | "adapter" | null;
  workerId: string | null;
  adapterId: string | null;
};

const WS_READY_STATE_CLOSED = 3;

export type StartFunclawHubOptions = {
  host?: string;
  port?: number;
  token?: string;
  dataDir?: string;
  publicBaseUrl?: string;
};

function jsonError(code: string, message: string, details?: unknown): ErrorShape {
  return { code, message, details };
}

function readBearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || undefined;
}

function sendError(res: ServerResponse, status: number, error: ErrorShape) {
  sendJson(res, status, { ok: false, error });
}

function parseRequestIdFromPath(pathname: string): string | null {
  const match = /^\/api\/v1\/requests\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function parseAwaitRequestIdFromPath(pathname: string): string | null {
  const match = /^\/api\/v1\/requests\/([^/]+)\/await$/.exec(pathname);
  return match?.[1] ?? null;
}

function parseSessionIdFromMessagesPath(pathname: string): string | null {
  const match = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(pathname);
  return match?.[1] ?? null;
}

function parseSessionIdFromHistoryPath(pathname: string): string | null {
  const match = /^\/api\/v1\/sessions\/([^/]+)\/history$/.exec(pathname);
  return match?.[1] ?? null;
}

function parseArtifactIdFromMetaPath(pathname: string): string | null {
  const match = /^\/api\/v1\/artifacts\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

function parseArtifactIdFromContentPath(pathname: string): string | null {
  const match = /^\/api\/v1\/artifacts\/([^/]+)\/content$/.exec(pathname);
  return match?.[1] ?? null;
}

function safeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeBaseUrl(host: string, port: number, explicit?: string): string {
  if (explicit?.trim()) {
    return explicit.replace(/\/+$/, "");
  }
  const publicHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${publicHost}:${port}`;
}

export async function startFunclawHubServer(opts: StartFunclawHubOptions = {}) {
  const host = opts.host?.trim() || HUB_DEFAULT_HOST;
  const port = Number.isFinite(opts.port) ? Number(opts.port) : HUB_DEFAULT_PORT;
  const token = opts.token?.trim() || "";
  const dataDir = resolveFunclawHubDataDir(opts.dataDir);
  const publicBaseUrl = normalizeBaseUrl(host, port, opts.publicBaseUrl);
  const store = new FunclawHubStore(dataDir, publicBaseUrl);
  await store.load();

  const sockets = new Set<HubClientState>();
  const adapterSockets = new Map<string, Set<HubClientState>>();
  const waiters = new Map<string, Set<(request: RequestRecord) => void>>();
  const wss = new WebSocketServer({ noServer: true });
  let eventSeq = 0;

  const notifyWaiters = (request: RequestRecord) => {
    const listeners = waiters.get(request.request_id);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(request);
    }
  };

  const notifyAdapters = (adapterId: string, event: string, payload: unknown) => {
    const targets = adapterSockets.get(adapterId);
    if (!targets) {
      return;
    }
    const frame = JSON.stringify({ type: "event", event, payload, seq: ++eventSeq });
    for (const client of targets) {
      client.socket.send(frame);
    }
  };

  const waitForRequestTerminal = async (requestId: string, timeoutMs: number) => {
    const current = store.getRequest(requestId);
    if (current && (current.status === "completed" || current.status === "failed" || current.status === "canceled")) {
      return current;
    }
    return await new Promise<RequestRecord | null>((resolve) => {
      const timer = setTimeout(() => {
        listeners.delete(onUpdate);
        resolve(store.getRequest(requestId) ?? null);
      }, timeoutMs);
      const listeners = waiters.get(requestId) ?? new Set<(request: RequestRecord) => void>();
      const onUpdate = (request: RequestRecord) => {
        if (request.status === "completed" || request.status === "failed" || request.status === "canceled") {
          clearTimeout(timer);
          listeners.delete(onUpdate);
          resolve(request);
        }
      };
      listeners.add(onUpdate);
      waiters.set(requestId, listeners);
    });
  };

  const requireHttpAuth = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!token) {
      return true;
    }
    if (readBearerToken(req) === token) {
      return true;
    }
    sendError(res, 401, jsonError("UNAUTHORIZED", "Missing or invalid bearer token"));
    return false;
  };

  const assignTask = (request: RequestRecord, session: SessionRouteRecord) => {
    const worker = [...sockets].find(
      (client) => client.connected && client.role === "worker" && client.workerId === session.worker_id,
    );
    if (!worker) {
      throw new Error(`Worker offline for session ${session.session_id}`);
    }
    worker.socket.send(
      JSON.stringify({
        type: "event",
        event: "task.assigned",
        payload: {
          request_id: request.request_id,
          session_id: request.session_id,
          worker_id: request.worker_id,
          adapter_id: request.adapter_id,
          openclaw_session_key: request.openclaw_session_key,
          action: request.action,
          input: request.input,
          created_at: request.created_at,
        },
        seq: ++eventSeq,
      }),
    );
  };

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = requestUrl.pathname;

    if (pathname === "/healthz" || pathname === "/health") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendMethodNotAllowed(res, "GET, HEAD");
        return;
      }
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.end();
        return;
      }
      sendJson(res, 200, { ok: true, status: "live" });
      return;
    }

    if (pathname === "/readyz" || pathname === "/ready") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendMethodNotAllowed(res, "GET, HEAD");
        return;
      }
      const ready = store.listWorkers().length > 0;
      if (req.method === "HEAD") {
        res.statusCode = ready ? 200 : 503;
        res.end();
        return;
      }
      sendJson(res, ready ? 200 : 503, {
        ok: ready,
        status: ready ? "ready" : "not_ready",
        workers_online: store.listWorkers().length,
      });
      return;
    }

    if (pathname === "/ws") {
      sendText(res, 426, "Upgrade Required");
      return;
    }

    if (!requireHttpAuth(req, res)) {
      return;
    }

    if (pathname === "/api/v1/workers") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      sendJson(res, 200, { ok: true, workers: store.listWorkers() });
      return;
    }

    if (pathname === "/api/v1/sessions") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const body = await readJsonBodyWithLimit(req, {
        maxBytes: HUB_DEFAULT_MAX_BODY_BYTES,
        timeoutMs: HUB_DEFAULT_REQUEST_TIMEOUT_MS,
      });
      if (!body.ok || !validateCreateSessionBody(body.value)) {
        sendError(res, 400, jsonError("INVALID_REQUEST", "Invalid session body", validateCreateSessionBody.errors));
        return;
      }
      const input = body.value as CreateSessionBody;
      try {
        const session = await store.ensureSession({
          sessionId: input.session_id,
          adapterId: safeString(input.adapter_id, "http-adapter"),
          openclawSessionKey: safeString(input.openclaw_session_key, `funclaw:${input.session_id}`),
        });
        sendJson(res, 200, { ok: true, session });
      } catch (error) {
        sendError(res, 503, jsonError("NO_WORKER", error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    const messageSessionId = parseSessionIdFromMessagesPath(pathname);
    if (messageSessionId) {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const body = await readJsonBodyWithLimit(req, {
        maxBytes: HUB_DEFAULT_MAX_BODY_BYTES,
        timeoutMs: HUB_DEFAULT_REQUEST_TIMEOUT_MS,
      });
      if (!body.ok || !validatePostSessionMessageBody(body.value)) {
        sendError(res, 400, jsonError("INVALID_REQUEST", "Invalid message body", validatePostSessionMessageBody.errors));
        return;
      }
      const input = body.value as PostSessionMessageBody;
      try {
        const session = await store.ensureSession({
          sessionId: messageSessionId,
          adapterId: safeString(input.adapter_id, "http-adapter"),
          openclawSessionKey: safeString(input.openclaw_session_key, `funclaw:${messageSessionId}`),
        });
        const request = await store.createRequest({
          requestId: input.request_id,
          session,
          action: input.action,
          input: input.input,
        });
        assignTask(request, session);
        notifyAdapters(request.adapter_id, "request.updated", request);
        sendJson(res, 202, { ok: true, request });
      } catch (error) {
        sendError(res, 503, jsonError("REQUEST_REJECTED", error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    const requestId = parseRequestIdFromPath(pathname);
    if (requestId) {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const request = store.getRequest(requestId);
      if (!request) {
        sendError(res, 404, jsonError("NOT_FOUND", "Request not found"));
        return;
      }
      sendJson(res, 200, { ok: true, request });
      return;
    }

    const awaitRequestId = parseAwaitRequestIdFromPath(pathname);
    if (awaitRequestId) {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res, "POST");
        return;
      }
      const body = await readJsonBodyWithLimit(req, {
        maxBytes: 1024,
        timeoutMs: HUB_DEFAULT_REQUEST_TIMEOUT_MS,
      });
      if (!body.ok || !validateAwaitRequestBody(body.value)) {
        sendError(res, 400, jsonError("INVALID_REQUEST", "Invalid await body", validateAwaitRequestBody.errors));
        return;
      }
      const timeoutMs = Math.max(
        1,
        Number((body.value as { timeout_ms?: number }).timeout_ms ?? HUB_DEFAULT_REQUEST_TIMEOUT_MS),
      );
      const settled = await waitForRequestTerminal(awaitRequestId, timeoutMs);
      if (!settled) {
        sendError(res, 404, jsonError("NOT_FOUND", "Request not found"));
        return;
      }
      const done =
        settled.status === "completed" || settled.status === "failed" || settled.status === "canceled";
      sendJson(res, done ? 200 : 202, { ok: done, request: settled });
      return;
    }

    const historySessionId = parseSessionIdFromHistoryPath(pathname);
    if (historySessionId) {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const session = store.getSession(historySessionId);
      if (!session) {
        sendError(res, 404, jsonError("NOT_FOUND", "Session not found"));
        return;
      }
      try {
        const request = await store.createRequest({
          session,
          action: "session.history.get",
          input: Object.fromEntries(requestUrl.searchParams.entries()),
        });
        assignTask(request, session);
        const settled = await waitForRequestTerminal(request.request_id, HUB_DEFAULT_REQUEST_TIMEOUT_MS);
        if (!settled) {
          sendError(res, 504, jsonError("TIMEOUT", "History request timed out"));
          return;
        }
        if (settled.status === "failed") {
          sendError(res, 502, settled.error ?? jsonError("UPSTREAM_ERROR", "History fetch failed"));
          return;
        }
        sendJson(res, 200, { ok: true, request_id: settled.request_id, result: settled.result });
      } catch (error) {
        sendError(res, 503, jsonError("REQUEST_REJECTED", error instanceof Error ? error.message : String(error)));
      }
      return;
    }

    const artifactId = parseArtifactIdFromMetaPath(pathname);
    if (artifactId) {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const artifact = store.getArtifact(artifactId);
      if (!artifact) {
        sendError(res, 404, jsonError("NOT_FOUND", "Artifact not found"));
        return;
      }
      sendJson(res, 200, { ok: true, artifact });
      return;
    }

    const artifactContentId = parseArtifactIdFromContentPath(pathname);
    if (artifactContentId) {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res, "GET");
        return;
      }
      const artifact = store.getArtifact(artifactContentId);
      if (!artifact) {
        sendError(res, 404, jsonError("NOT_FOUND", "Artifact not found"));
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", artifact.mime_type);
      res.setHeader("Content-Disposition", `inline; filename="${artifact.filename}"`);
      if (artifact.transport === "inline" && artifact.inline_base64) {
        res.end(Buffer.from(artifact.inline_base64, "base64"));
        return;
      }
      if (artifact.transport === "hub_file") {
        const filePath = store.resolveArtifactFilePath(artifact.artifact_id, artifact.filename);
        const raw = await import("node:fs/promises").then((mod) => mod.readFile(filePath)).catch(() => null);
        if (!raw) {
          sendError(res, 404, jsonError("NOT_FOUND", "Artifact content missing"));
          return;
        }
        res.end(raw);
        return;
      }
      sendError(res, 501, jsonError("UNSUPPORTED_TRANSPORT", "Artifact transport is not implemented"));
      return;
    }

    sendError(res, 404, jsonError("NOT_FOUND", "Route not found"));
  });

  server.on("upgrade", (req, socket, head) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (requestUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket) => {
    const clientState: HubClientState = {
      connId: randomUUID(),
      socket,
      connected: false,
      challengeNonce: randomUUID(),
      role: null,
      workerId: null,
      adapterId: null,
    };
    sockets.add(clientState);
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: {
          nonce: clientState.challengeNonce,
          ts: Date.now(),
        },
        seq: ++eventSeq,
      }),
    );
    const connectTimer = setTimeout(() => {
      if (!clientState.connected) {
        socket.close(1008, "connect timeout");
      }
    }, HUB_DEFAULT_CONNECT_TIMEOUT_MS);

    socket.on("message", async (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        socket.send(JSON.stringify({
          type: "res",
          id: randomUUID(),
          ok: false,
          error: jsonError("INVALID_JSON", "Message must be valid JSON"),
        }));
        return;
      }
      if (!validateHubRequestFrame(parsed)) {
        socket.send(JSON.stringify({
          type: "res",
          id: randomUUID(),
          ok: false,
          error: jsonError("INVALID_FRAME", "Invalid request frame", validateHubRequestFrame.errors),
        }));
        return;
      }
      const frame = parsed as HubRequestFrame;
      const respond = (ok: boolean, payload?: unknown, error?: ErrorShape) => {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok, payload, error }));
      };

      if (!clientState.connected) {
        if (frame.method !== "connect" || !validateHubConnectParams(frame.params)) {
          respond(false, undefined, jsonError("CONNECT_REQUIRED", "First frame must be a valid connect request"));
          return;
        }
        const params = frame.params as HubConnectParams;
        if (params.nonce !== clientState.challengeNonce) {
          respond(false, undefined, jsonError("BAD_NONCE", "connect nonce mismatch"));
          return;
        }
        if (params.minProtocol > 1 || params.maxProtocol < 1) {
          respond(false, undefined, jsonError("BAD_PROTOCOL", "Hub protocol version mismatch"));
          return;
        }
        if (token && params.auth?.token !== token) {
          respond(false, undefined, jsonError("UNAUTHORIZED", "Hub token mismatch"));
          return;
        }
        if (params.role === "worker" && !params.worker) {
          respond(false, undefined, jsonError("INVALID_CONNECT", "worker registration required"));
          return;
        }
        if (params.role === "adapter" && !params.adapter) {
          respond(false, undefined, jsonError("INVALID_CONNECT", "adapter registration required"));
          return;
        }
        clearTimeout(connectTimer);
        if (params.role === "worker" && params.worker) {
          const worker: ConnectedWorkerState = {
            workerId: params.worker.worker_id,
            hostname: params.worker.hostname,
            version: params.worker.version,
            capabilities: params.worker.capabilities,
            connectedAt: new Date().toISOString(),
            lastHeartbeatAt: new Date().toISOString(),
          };
          store.addWorker(worker);
          clientState.connected = true;
          clientState.role = "worker";
          clientState.workerId = worker.workerId;
        } else if (params.role === "adapter" && params.adapter) {
          clientState.connected = true;
          clientState.role = "adapter";
          clientState.adapterId = params.adapter.adapter_id;
          const set = adapterSockets.get(params.adapter.adapter_id) ?? new Set<HubClientState>();
          set.add(clientState);
          adapterSockets.set(params.adapter.adapter_id, set);
        }
        respond(true, buildHubHelloOk(clientState.connId, VERSION));
        return;
      }

      try {
        if (frame.method === "worker.heartbeat") {
          if (!validateWorkerHeartbeatPayload(frame.params)) {
            respond(false, undefined, jsonError("INVALID_HEARTBEAT", "Invalid heartbeat payload"));
            return;
          }
          const payload = frame.params as { worker_id: string };
          store.markWorkerHeartbeat(payload.worker_id);
          respond(true, { ok: true });
          return;
        }

        if (frame.method === "task.accepted") {
          if (!validateTaskAcceptedPayload(frame.params)) {
            respond(false, undefined, jsonError("INVALID_TASK_ACCEPTED", "Invalid task.accepted payload"));
            return;
          }
          const payload = frame.params as { request_id: string; accepted_at: string };
          await store.markAccepted(payload.request_id, payload.accepted_at);
          const request = store.getRequest(payload.request_id);
          if (request) {
            notifyWaiters(request);
            notifyAdapters(request.adapter_id, "request.updated", request);
          }
          respond(true, { ok: true });
          return;
        }

        if (frame.method === "task.output") {
          if (!validateTaskOutputPayload(frame.params)) {
            respond(false, undefined, jsonError("INVALID_TASK_OUTPUT", "Invalid task.output payload"));
            return;
          }
          const payload = frame.params as RequestRecord["outputs"][number] & { request_id: string };
          await store.appendOutput(payload.request_id, payload);
          const request = store.getRequest(payload.request_id);
          if (request) {
            notifyWaiters(request);
            notifyAdapters(request.adapter_id, "request.updated", request);
          }
          respond(true, { ok: true });
          return;
        }

        if (frame.method === "artifact.register") {
          if (!validateArtifactRegisterParams(frame.params)) {
            respond(false, undefined, jsonError("INVALID_ARTIFACT", "Invalid artifact.register payload"));
            return;
          }
          const payload = frame.params as ArtifactRegisterParams;
          const descriptor = await store.registerArtifact({
            requestId: payload.request_id,
            kind: payload.artifact.kind,
            filename: payload.artifact.filename,
            mimeType: payload.artifact.mime_type,
            contentBase64: payload.artifact.content_base64,
            meta: payload.artifact.meta,
          });
          const request = store.getRequest(payload.request_id);
          if (request) {
            notifyAdapters(request.adapter_id, "artifact.ready", descriptor);
          }
          respond(true, descriptor);
          return;
        }

        if (frame.method === "task.completed") {
          if (!validateTaskCompletedPayload(frame.params)) {
            respond(false, undefined, jsonError("INVALID_TASK_COMPLETED", "Invalid task.completed payload"));
            return;
          }
          const payload = frame.params as { request_id: string; completed_at: string; result: unknown; artifacts: RequestRecord["artifacts"] };
          await store.markCompleted(payload.request_id, payload.result, payload.artifacts, payload.completed_at);
          const request = store.getRequest(payload.request_id);
          if (request) {
            notifyWaiters(request);
            notifyAdapters(request.adapter_id, "request.completed", request);
          }
          respond(true, { ok: true });
          return;
        }

        if (frame.method === "task.failed") {
          if (!validateTaskFailedPayload(frame.params)) {
            respond(false, undefined, jsonError("INVALID_TASK_FAILED", "Invalid task.failed payload"));
            return;
          }
          const payload = frame.params as { request_id: string; failed_at: string; error: ErrorShape };
          await store.markFailed(payload.request_id, payload.error, payload.failed_at);
          const request = store.getRequest(payload.request_id);
          if (request) {
            notifyWaiters(request);
            notifyAdapters(request.adapter_id, "request.completed", request);
          }
          respond(true, { ok: true });
          return;
        }
      } catch (error) {
        respond(false, undefined, jsonError("SERVER_ERROR", error instanceof Error ? error.message : String(error)));
        return;
      }

      respond(false, undefined, jsonError("UNKNOWN_METHOD", `Unknown method: ${frame.method}`));
    });

    socket.on("close", () => {
      clearTimeout(connectTimer);
      sockets.delete(clientState);
      if (clientState.connected && clientState.role === "worker" && clientState.workerId) {
        store.removeWorker(clientState.workerId);
      }
      if (clientState.connected && clientState.role === "adapter" && clientState.adapterId) {
        adapterSockets.get(clientState.adapterId)?.delete(clientState);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  defaultRuntime.log(`FunClaw Hub listening on http://${host}:${port} (public: ${publicBaseUrl})`);

  return {
    host,
    port,
    publicBaseUrl,
    store,
    server,
    async close(reason?: string) {
      const closePromises = [...sockets].map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.socket.readyState === WS_READY_STATE_CLOSED) {
              resolve();
              return;
            }
            client.socket.once("close", () => resolve());
          }),
      );
      for (const client of sockets) {
        client.socket.close(1000, reason ?? "shutdown");
      }
      await Promise.allSettled(closePromises);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

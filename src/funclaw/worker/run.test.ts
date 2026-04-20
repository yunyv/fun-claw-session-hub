import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../../infra/ws.js";
import { startFunclawHubServer } from "../hub/server.js";
import { startFunclawWorker } from "./run.js";

const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8AARAAA//8DAF0BBq1W3CYAAAAASUVORK5CYII=";

type Cleanup = () => Promise<void> | void;

type GatewayStubState = {
  agentCalls: Array<{ sessionKey: string; message: string; attachments: unknown[] }>;
  nodeCalls: Array<Record<string, unknown>>;
  sessions: Map<string, { replyText: string; completed: boolean }>;
};

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function createTempDir(prefix: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function removeDirWithRetry(dirPath: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOTEMPTY" && code !== "EBUSY") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function startGatewayStub() {
  const port = await getFreePort();
  const state: GatewayStubState = {
    agentCalls: [],
    nodeCalls: [],
    sessions: new Map(),
  };
  const runIdToSession = new Map<string, string>();
  let runCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = /^\/sessions\/(.+)\/history$/.exec(requestUrl.pathname);
    if (req.method === "GET" && match) {
      const sessionKey = decodeURIComponent(match[1] ?? "");
      const session = state.sessions.get(sessionKey) ?? {
        replyText: `reply:${sessionKey}`,
        completed: false,
      };
      state.sessions.set(sessionKey, session);
      const items = [
        {
          role: "user",
          content: [{ type: "text", text: `user:${sessionKey}` }],
          __openclaw: { seq: 1 },
        },
      ];
      if (session.completed) {
        items.push({
          role: "assistant",
          content: [{ type: "text", text: session.replyText }],
          usage: { output_tokens: 7 },
          __openclaw: { seq: 2 },
        });
      }
      sendJson(res, 200, { items });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: {
          nonce: "gateway-nonce",
          ts: Date.now(),
        },
      }),
    );

    socket.on("message", (raw) => {
      const frame = JSON.parse(rawDataToString(raw)) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };

      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              policy: {
                heartbeatIntervalMs: 15_000,
              },
            },
          }),
        );
        return;
      }

      if (frame.method === "agent") {
        const sessionKey = String(frame.params?.sessionKey ?? "");
        const message = String(frame.params?.message ?? "");
        const attachments = Array.isArray(frame.params?.attachments) ? frame.params.attachments : [];
        state.agentCalls.push({ sessionKey, message, attachments });
        state.sessions.set(sessionKey, {
          replyText: `assistant:${message}`,
          completed: false,
        });
        const runId = `run-${++runCounter}`;
        runIdToSession.set(runId, sessionKey);
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "accepted",
            },
          }),
        );
        return;
      }

      if (frame.method === "agent.wait") {
        const runId = String(frame.params?.runId ?? "");
        const sessionKey = runIdToSession.get(runId) ?? "";
        const session = state.sessions.get(sessionKey);
        if (session) {
          session.completed = true;
        }
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              runId,
              status: "completed",
            },
          }),
        );
        return;
      }

      if (frame.method === "node.invoke") {
        state.nodeCalls.push(frame.params ?? {});
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              format: "png",
              mimeType: "image/png",
              base64: SMALL_PNG_BASE64,
              note: "rendered",
            },
          }),
        );
        return;
      }

      socket.send(
        JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "UNKNOWN_METHOD",
            message: `Unknown method: ${frame.method}`,
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    state,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      wss.close();
    },
  };
}

async function authedFetch(port: number, pathname: string, init?: RequestInit, token = "hub-secret") {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers,
  });
}

async function waitForWorkerReady(port: number, workerId: string, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await authedFetch(port, "/api/v1/workers");
    if (response.ok) {
      const body = (await response.json()) as { workers?: Array<{ workerId?: string; worker_id?: string }> };
      const found = body.workers?.some((worker) => worker.workerId === workerId || worker.worker_id === workerId);
      if (found) {
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for worker ${workerId}`);
}

async function awaitRequest(port: number, requestId: string) {
  const response = await authedFetch(port, `/api/v1/requests/${requestId}/await`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ timeout_ms: 30_000 }),
  });
  const body = (await response.json()) as { request: Record<string, unknown> };
  return {
    status: response.status,
    body,
  };
}

describe("funclaw go worker", () => {
  const cleanups: Cleanup[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("runs the full hub -> go worker -> gateway flow for responses, history, and node.invoke", async () => {
    const gateway = await startGatewayStub();
    cleanups.push(() => gateway.close());

    const hubPort = await getFreePort();
    const hubDataDir = await createTempDir("funclaw-hub-test.");
    cleanups.push(() => removeDirWithRetry(hubDataDir));

    const hub = await startFunclawHubServer({
      host: "127.0.0.1",
      port: hubPort,
      token: "hub-secret",
      dataDir: hubDataDir,
      publicBaseUrl: `http://127.0.0.1:${hubPort}`,
    });
    cleanups.push(() => hub.close("test done"));

    const worker = await startFunclawWorker({
      hubUrl: `ws://127.0.0.1:${hubPort}/ws`,
      hubToken: "hub-secret",
      workerId: "go-worker-1",
      gatewayBaseUrl: gateway.url,
      gatewayWsUrl: gateway.wsUrl,
      gatewayToken: "gateway-secret",
      capabilities: ["responses.create", "agent", "session.history.get", "node.invoke"],
      stdio: "ignore",
    });
    cleanups.push(() => worker.close());

    await waitForWorkerReady(hubPort, "go-worker-1");

    const createSessionRes = await authedFetch(hubPort, "/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "session-1",
        adapter_id: "adapter-a",
        openclaw_session_key: "session-key-1",
      }),
    });
    expect(createSessionRes.status).toBe(200);

    const responsesCreateRes = await authedFetch(hubPort, "/api/v1/sessions/session-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "responses.create",
        openclaw_session_key: "session-key-1",
        input: {
          model: "openclaw",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "你好，帮我总结一下" }],
            },
          ],
        },
      }),
    });
    expect(responsesCreateRes.status).toBe(202);
    const responsesCreateJson = (await responsesCreateRes.json()) as { request: { request_id: string } };
    const responseRequest = await awaitRequest(hubPort, responsesCreateJson.request.request_id);
    expect(responseRequest.status).toBe(200);
    expect(responseRequest.body.request.status).toBe("completed");
    expect(responseRequest.body.request.result).toEqual({
      payloads: [{ text: "assistant:你好，帮我总结一下" }],
      meta: { usage: { output_tokens: 7 } },
    });
    expect(gateway.state.agentCalls).toHaveLength(1);
    expect(gateway.state.agentCalls[0]).toMatchObject({
      sessionKey: "session-key-1",
      message: "你好，帮我总结一下",
    });

    const historyRes = await authedFetch(hubPort, "/api/v1/sessions/session-1/history");
    expect(historyRes.status).toBe(200);
    const historyJson = (await historyRes.json()) as {
      result: { items: Array<{ role: string; content: Array<{ text: string }> }> };
    };
    expect(historyJson.result.items.at(-1)?.role).toBe("assistant");
    expect(historyJson.result.items.at(-1)?.content.at(0)?.text).toBe("assistant:你好，帮我总结一下");

    const nodeInvokeRes = await authedFetch(hubPort, "/api/v1/sessions/session-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "node.invoke",
        input: {
          node: "canvas.render",
          params: {
            prompt: "画一个红点",
          },
        },
      }),
    });
    expect(nodeInvokeRes.status).toBe(202);
    const nodeInvokeJson = (await nodeInvokeRes.json()) as { request: { request_id: string } };
    const nodeRequest = await awaitRequest(hubPort, nodeInvokeJson.request.request_id);
    expect(nodeRequest.status).toBe(200);
    expect(nodeRequest.body.request.status).toBe("completed");
    expect(nodeRequest.body.request.artifacts).toHaveLength(1);
    expect(gateway.state.nodeCalls).toHaveLength(1);
    expect(gateway.state.nodeCalls[0]).toMatchObject({
      nodeId: "canvas",
      command: "render",
      params: {
        prompt: "画一个红点",
      },
    });

    const [artifact] = nodeRequest.body.request.artifacts as Array<{ artifact_id: string; mime_type: string }>;
    const artifactMetaRes = await authedFetch(hubPort, `/api/v1/artifacts/${artifact.artifact_id}`);
    expect(artifactMetaRes.status).toBe(200);
    const artifactContentRes = await authedFetch(hubPort, `/api/v1/artifacts/${artifact.artifact_id}/content`);
    expect(artifactContentRes.status).toBe(200);
    expect(artifactContentRes.headers.get("content-type")).toBe("image/png");
    const artifactBytes = Buffer.from(await artifactContentRes.arrayBuffer());
    expect(artifactBytes.byteLength).toBeGreaterThan(0);
  });
});

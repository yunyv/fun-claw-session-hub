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
const LARGE_FILE_BYTES = Buffer.alloc(1_100_000, 7);

type Cleanup = () => Promise<void> | void;

type GatewayHistoryItem = Record<string, unknown>;

type GatewayDownload = {
  body: Buffer;
  contentType: string;
  contentDisposition?: string;
};

type GatewayStubSession = {
  completed: boolean;
  historyItems: GatewayHistoryItem[];
  waitDelayMs?: number;
};

type GatewayStubState = {
  agentCalls: Array<{
    sessionKey: string;
    message: string;
    attachments: unknown[];
    extraSystemPrompt: string;
  }>;
  nodeCalls: Array<Record<string, unknown>>;
  sessions: Map<string, GatewayStubSession>;
  downloads: Map<string, GatewayDownload>;
};

type RunningGatewayStub = Awaited<ReturnType<typeof startGatewayStub>>;

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

function buildHistoryItems(sessionKey: string, session?: GatewayStubSession) {
  const items: GatewayHistoryItem[] = [
    {
      role: "user",
      content: [{ type: "text", text: `user:${sessionKey}` }],
      __openclaw: { seq: 1 },
    },
  ];
  if (session?.completed) {
    items.push(...session.historyItems);
  }
  return items;
}

function buildSessionScenario(
  baseUrl: string,
  downloads: Map<string, GatewayDownload>,
  sessionKey: string,
  message: string,
  runIndex: number,
): GatewayStubSession {
  const assistantText = `assistant:${message}`;
  const seqOffset = runIndex * 10;
  const assistantSeq = seqOffset + 4;

  if (message === "你好，帮我总结一下") {
    return {
      completed: false,
      historyItems: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: `call:${sessionKey}`,
              name: "read",
              arguments: {
                path: "/tmp/demo.txt",
                limit: 1,
              },
            },
          ],
          __openclaw: { seq: seqOffset + 2 },
        },
        {
          role: "toolResult",
          toolCallId: `call:${sessionKey}`,
          toolName: "read",
          content: [{ type: "text", text: "---\n\n[233 more lines in file.]" }],
          isError: false,
          __openclaw: { seq: seqOffset + 3 },
        },
        {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
          usage: { output_tokens: 7 },
          __openclaw: { seq: assistantSeq },
        },
      ],
    };
  }

  if (message === "给我一个内嵌图片") {
    return {
      completed: false,
      historyItems: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "这里是内嵌图片结果" },
            {
              type: "image",
              filename: "inline.png",
              mimeType: "image/png",
              base64: SMALL_PNG_BASE64,
            },
          ],
          usage: { output_tokens: 11 },
          __openclaw: { seq: assistantSeq },
        },
      ],
    };
  }

  if (message === "给我一个下载文件") {
    downloads.set("big-report", {
      body: LARGE_FILE_BYTES,
      contentType: "application/octet-stream",
      contentDisposition: `attachment; filename="report.bin"`,
    });
    return {
      completed: false,
      historyItems: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "报告已经准备好" },
            {
              type: "file",
              download_url: `${baseUrl}/downloads/big-report`,
            },
          ],
          usage: { output_tokens: 13 },
          __openclaw: { seq: assistantSeq },
        },
      ],
    };
  }

  if (message === "给我一个 agent 下载链接") {
    downloads.set("agent-note", {
      body: Buffer.from("agent file"),
      contentType: "text/plain; charset=utf-8",
      contentDisposition: `attachment; filename="agent-note.txt"`,
    });
    return {
      completed: false,
      historyItems: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `这是 agent 的下载链接\n${baseUrl}/downloads/agent-note`,
            },
          ],
          usage: { output_tokens: 9 },
          __openclaw: { seq: assistantSeq },
        },
      ],
    };
  }

  if (message === "并发请求-1") {
    return {
      completed: false,
      waitDelayMs: 200,
      historyItems: [
        {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
          usage: { output_tokens: 5 },
          __openclaw: { seq: assistantSeq },
        },
      ],
    };
  }

  if (message === "并发请求-2") {
    return {
      completed: false,
      waitDelayMs: 0,
      historyItems: [
        {
          role: "assistant",
          content: [{ type: "text", text: assistantText }],
          usage: { output_tokens: 5 },
          __openclaw: { seq: assistantSeq },
        },
      ],
    };
  }

  return {
    completed: false,
    historyItems: [
      {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
        usage: { output_tokens: 7 },
        __openclaw: { seq: assistantSeq },
      },
    ],
  };
}

async function startGatewayStub() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const state: GatewayStubState = {
    agentCalls: [],
    nodeCalls: [],
    sessions: new Map(),
    downloads: new Map(),
  };
  const runIdToSession = new Map<string, string>();
  const sessionRuns = new Map<string, number>();
  let runCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const historyMatch = /^\/sessions\/(.+)\/history$/.exec(requestUrl.pathname);
    if (req.method === "GET" && historyMatch) {
      const sessionKey = decodeURIComponent(historyMatch[1] ?? "");
      const session = state.sessions.get(sessionKey);
      sendJson(res, 200, { items: buildHistoryItems(sessionKey, session) });
      return;
    }

    const downloadMatch = /^\/downloads\/([^/]+)$/.exec(requestUrl.pathname);
    if (req.method === "GET" && downloadMatch) {
      const download = state.downloads.get(downloadMatch[1] ?? "");
      if (!download) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", download.contentType);
      if (download.contentDisposition) {
        res.setHeader("content-disposition", download.contentDisposition);
      }
      res.end(download.body);
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
        const extraSystemPrompt = String(frame.params?.extraSystemPrompt ?? "");
        state.agentCalls.push({ sessionKey, message, attachments, extraSystemPrompt });
        const runIndex = sessionRuns.get(sessionKey) ?? 0;
        sessionRuns.set(sessionKey, runIndex + 1);
        state.sessions.set(sessionKey, buildSessionScenario(baseUrl, state.downloads, sessionKey, message, runIndex));
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
        const waitDelayMs = session?.waitDelayMs ?? 0;
        setTimeout(() => {
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
        }, waitDelayMs);
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
    url: baseUrl,
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

async function setupWorkerHarness(cleanups: Cleanup[]) {
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

  return { gateway, hubPort };
}

async function createSession(hubPort: number, sessionId: string, sessionKey: string) {
  const response = await authedFetch(hubPort, "/api/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      adapter_id: "adapter-a",
      openclaw_session_key: sessionKey,
    }),
  });
  expect(response.status).toBe(200);
}

async function submitMessage(
  hubPort: number,
  sessionId: string,
  body: {
    action: string;
    openclaw_session_key?: string;
    input: Record<string, unknown>;
  },
) {
  const response = await authedFetch(hubPort, `/api/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
  const json = (await response.json()) as { request: { request_id: string } };
  return json.request.request_id;
}

async function fetchArtifactContent(
  hubPort: number,
  artifactId: string,
) {
  const metaRes = await authedFetch(hubPort, `/api/v1/artifacts/${artifactId}`);
  expect(metaRes.status).toBe(200);
  const contentRes = await authedFetch(hubPort, `/api/v1/artifacts/${artifactId}/content`);
  expect(contentRes.status).toBe(200);
  const bytes = Buffer.from(await contentRes.arrayBuffer());
  return {
    meta: (await metaRes.json()) as { artifact: Record<string, unknown> },
    contentRes,
    bytes,
  };
}

describe("funclaw go worker", () => {
  const cleanups: Cleanup[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("keeps pure text responses.create results unchanged", async () => {
    const { gateway, hubPort } = await setupWorkerHarness(cleanups);
    await createSession(hubPort, "session-text", "session-key-text");

    const requestId = await submitMessage(hubPort, "session-text", {
      action: "responses.create",
      openclaw_session_key: "session-key-text",
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
    });

    const responseRequest = await awaitRequest(hubPort, requestId);
    const request = responseRequest.body.request as {
      status: string;
      result: Record<string, unknown>;
      artifacts: unknown[];
    };
    expect(responseRequest.status).toBe(200);
    expect(request.status).toBe("completed");
    expect(request.result).toEqual({
      payloads: [{ text: "assistant:你好，帮我总结一下" }],
      meta: { usage: { output_tokens: 7 } },
      tool_calls: [
        {
          seq: 2,
          id: "call:session-key-text",
          name: "read",
          arguments: {
            path: "/tmp/demo.txt",
            limit: 1,
          },
        },
      ],
      tool_results_summary: [
        {
          seq: 3,
          tool_call_id: "call:session-key-text",
          name: "read",
          summary: "--- [233 more lines in file.]",
          is_error: false,
        },
      ],
    });
    expect(request.artifacts).toEqual([]);
    expect(gateway.state.agentCalls).toHaveLength(1);
    expect(gateway.state.agentCalls[0]).toMatchObject({
      sessionKey: "session-key-text",
      message: "你好，帮我总结一下",
    });
    expect(gateway.state.agentCalls[0]?.extraSystemPrompt).toContain(
      "A local filesystem path alone does not count as completed delivery.",
    );
  });

  it("registers inline artifacts for responses.create history blocks", async () => {
    const { hubPort } = await setupWorkerHarness(cleanups);
    await createSession(hubPort, "session-inline", "session-key-inline");

    const requestId = await submitMessage(hubPort, "session-inline", {
      action: "responses.create",
      openclaw_session_key: "session-key-inline",
      input: {
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "给我一个内嵌图片" }],
          },
        ],
      },
    });

    const responseRequest = await awaitRequest(hubPort, requestId);
    const request = responseRequest.body.request as {
      status: string;
      result: { payloads: Array<{ text: string }> };
      artifacts: Array<{ artifact_id: string; transport: string; mime_type: string }>;
    };
    expect(request.status).toBe("completed");
    expect(request.result.payloads[0]?.text).toBe("这里是内嵌图片结果");
    expect(request.artifacts).toHaveLength(1);
    expect(request.artifacts[0]?.transport).toBe("inline");

    const artifact = await fetchArtifactContent(hubPort, request.artifacts[0]!.artifact_id);
    expect(artifact.contentRes.headers.get("content-type")).toBe("image/png");
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
  });

  it("registers hub_file artifacts for URL outputs in responses.create", async () => {
    const { hubPort } = await setupWorkerHarness(cleanups);
    await createSession(hubPort, "session-download", "session-key-download");

    const requestId = await submitMessage(hubPort, "session-download", {
      action: "responses.create",
      openclaw_session_key: "session-key-download",
      input: {
        model: "openclaw",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "给我一个下载文件" }],
          },
        ],
      },
    });

    const responseRequest = await awaitRequest(hubPort, requestId);
    const request = responseRequest.body.request as {
      status: string;
      artifacts: Array<{ artifact_id: string; transport: string; filename: string }>;
    };
    expect(request.status).toBe("completed");
    expect(request.artifacts).toHaveLength(1);
    expect(request.artifacts[0]?.transport).toBe("hub_file");
    expect(request.artifacts[0]?.filename).toBe("report.bin");

    const artifact = await fetchArtifactContent(hubPort, request.artifacts[0]!.artifact_id);
    expect(artifact.bytes.byteLength).toBe(1_100_000);
  });

  it("registers artifacts for agent and keeps response text intact", async () => {
    const { hubPort } = await setupWorkerHarness(cleanups);
    await createSession(hubPort, "session-agent", "session-key-agent");

    const requestId = await submitMessage(hubPort, "session-agent", {
      action: "agent",
      openclaw_session_key: "session-key-agent",
      input: {
        message: "给我一个 agent 下载链接",
      },
    });

    const responseRequest = await awaitRequest(hubPort, requestId);
    const request = responseRequest.body.request as {
      status: string;
      result: { payloads: Array<{ text: string }> };
      artifacts: Array<{ artifact_id: string; transport: string; filename: string }>;
    };
    expect(request.status).toBe("completed");
    expect(request.result.payloads[0]?.text).toContain("这是 agent 的下载链接");
    expect(request.result.payloads[0]?.text).toContain("/downloads/agent-note");
    expect(request.artifacts).toHaveLength(1);
    expect(request.artifacts[0]?.transport).toBe("inline");
    expect(request.artifacts[0]?.filename).toBe("agent-note.txt");

    const artifact = await fetchArtifactContent(hubPort, request.artifacts[0]!.artifact_id);
    expect(artifact.contentRes.headers.get("content-type")).toContain("text/plain");
    expect(artifact.bytes.toString("utf8")).toBe("agent file");
  });

  it("serializes concurrent requests with the same session key", async () => {
    const { hubPort } = await setupWorkerHarness(cleanups);
    await createSession(hubPort, "session-serial", "session-key-serial");

    const [firstRequestId, secondRequestId] = await Promise.all([
      submitMessage(hubPort, "session-serial", {
        action: "responses.create",
        openclaw_session_key: "session-key-serial",
        input: {
          model: "openclaw",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "并发请求-1" }],
            },
          ],
        },
      }),
      submitMessage(hubPort, "session-serial", {
        action: "responses.create",
        openclaw_session_key: "session-key-serial",
        input: {
          model: "openclaw",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "并发请求-2" }],
            },
          ],
        },
      }),
    ]);

    const [firstRequest, secondRequest] = await Promise.all([
      awaitRequest(hubPort, firstRequestId),
      awaitRequest(hubPort, secondRequestId),
    ]);

    const first = firstRequest.body.request as { result: { payloads: Array<{ text: string }> } };
    const second = secondRequest.body.request as { result: { payloads: Array<{ text: string }> } };
    expect(first.result.payloads[0]?.text).toBe("assistant:并发请求-1");
    expect(second.result.payloads[0]?.text).toBe("assistant:并发请求-2");
  });

  it("keeps node.invoke artifact flow working", async () => {
    const { gateway, hubPort } = await setupWorkerHarness(cleanups);
    await createSession(hubPort, "session-node", "session-key-node");

    const requestId = await submitMessage(hubPort, "session-node", {
      action: "node.invoke",
      input: {
        node: "canvas.render",
        params: {
          prompt: "画一个红点",
        },
      },
    });

    const responseRequest = await awaitRequest(hubPort, requestId);
    const request = responseRequest.body.request as {
      status: string;
      artifacts: Array<{ artifact_id: string; mime_type: string }>;
    };
    expect(request.status).toBe("completed");
    expect(request.artifacts).toHaveLength(1);
    expect(gateway.state.nodeCalls).toHaveLength(1);
    expect(gateway.state.nodeCalls[0]).toMatchObject({
      nodeId: "canvas",
      command: "render",
      params: {
        prompt: "画一个红点",
      },
    });

    const artifact = await fetchArtifactContent(hubPort, request.artifacts[0]!.artifact_id);
    expect(artifact.contentRes.headers.get("content-type")).toBe("image/png");
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
  });
});

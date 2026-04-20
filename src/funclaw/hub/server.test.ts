import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { rawDataToString } from "../../infra/ws.js";
import { buildHubHelloOk, HUB_PROTOCOL_VERSION } from "../contracts/index.js";
import { startFunclawHubServer } from "./server.js";

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
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

async function connectWorker(params: { port: number; token: string; workerId?: string }) {
  const ws = new WebSocket(`ws://127.0.0.1:${params.port}/ws`);
  const buffered: Record<string, unknown>[] = [];
  ws.on("message", (raw) => {
    buffered.push(JSON.parse(rawDataToString(raw)) as Record<string, unknown>);
  });
  Reflect.set(ws, "__bufferedMessages", buffered);
  await once(ws, "open");
  const challenge = (await waitForWsMessage(ws, (message) => message.event === "connect.challenge")) as {
    payload?: { nonce?: string };
  };
  ws.send(
    JSON.stringify({
      type: "req",
      id: "connect-1",
      method: "connect",
      params: {
        minProtocol: HUB_PROTOCOL_VERSION,
        maxProtocol: HUB_PROTOCOL_VERSION,
        client: {
          id: "test-worker",
          version: "1.0.0",
          platform: "test",
          mode: "worker",
        },
        role: "worker",
        auth: { token: params.token },
          nonce: challenge.payload?.nonce ?? "",
        worker: {
          worker_id: params.workerId ?? "worker-1",
          hostname: "test-host",
          version: "1.0.0",
          capabilities: ["responses.create"],
        },
      },
    }),
  );
  const hello = (await waitForWsMessage(ws, (message) => message.id === "connect-1")) as {
    ok?: boolean;
    payload?: { type?: string };
  };
  expect(hello.ok).toBe(true);
  expect(hello.payload?.type).toBe(buildHubHelloOk("x", "x").type);
  return ws;
}

async function waitForWsMessage(
  ws: WebSocket,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs = 3_000,
) {
  const buffered = Reflect.get(ws, "__bufferedMessages") as Record<string, unknown>[] | undefined;
  const existing = buffered?.find(predicate);
  if (existing) {
    return existing;
  }
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for websocket message"));
    }, timeoutMs);
    const onMessage = (raw: RawData) => {
      const parsed = JSON.parse(rawDataToString(raw)) as Record<string, unknown>;
      if (!predicate(parsed)) {
        return;
      }
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(parsed);
    };
    ws.on("message", onMessage);
  });
}

async function authedFetch(
  port: number,
  path: string,
  init?: RequestInit,
  token = "hub-secret",
) {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
  });
}

describe("funclaw hub server", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("routes a request to a connected worker and returns the completed result", async () => {
    const port = await getFreePort();
    const dataDir = await createTempDir("funclaw-hub-test.");
    cleanups.push(() => removeDirWithRetry(dataDir));
    const hub = await startFunclawHubServer({
      host: "127.0.0.1",
      port,
      token: "hub-secret",
      dataDir,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    cleanups.push(() => hub.close("test done"));
    const worker = await connectWorker({ port, token: "hub-secret" });
    cleanups.push(async () => worker.close());

    const createSessionRes = await authedFetch(port, "/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session-1", adapter_id: "adapter-a" }),
    });
    expect(createSessionRes.status).toBe(200);

    const messageRes = await authedFetch(port, "/api/v1/sessions/session-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "responses.create",
        input: { model: "openclaw", input: "hi" },
      }),
    });
    expect(messageRes.status).toBe(202);
    const messageJson = (await messageRes.json()) as { request: { request_id: string } };
    const requestId = messageJson.request.request_id;

    const taskAssigned = (await waitForWsMessage(
      worker,
      (message) => message.event === "task.assigned",
    )) as { event?: string; payload?: { request_id?: string } };
    expect(taskAssigned.event).toBe("task.assigned");
    expect(taskAssigned.payload?.request_id).toBe(requestId);

    worker.send(
      JSON.stringify({
        type: "req",
        id: "accepted-1",
        method: "task.accepted",
        params: {
          request_id: requestId,
          accepted_at: new Date().toISOString(),
        },
      }),
    );
    await waitForWsMessage(worker, (message) => message.id === "accepted-1");

    worker.send(
      JSON.stringify({
        type: "req",
        id: "completed-1",
        method: "task.completed",
        params: {
          request_id: requestId,
          completed_at: new Date().toISOString(),
          result: { output_text: "hello from worker" },
          artifacts: [],
        },
      }),
    );
    await waitForWsMessage(worker, (message) => message.id === "completed-1");

    const awaitRes = await authedFetch(port, `/api/v1/requests/${requestId}/await`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout_ms: 1000 }),
    });
    expect(awaitRes.status).toBe(200);
    const awaitJson = (await awaitRes.json()) as { request: { status: string; result: { output_text: string } } };
    expect(awaitJson.request.status).toBe("completed");
    expect(awaitJson.request.result.output_text).toBe("hello from worker");
  });

  it("stores large artifacts as hub_file and serves the content endpoint", async () => {
    const port = await getFreePort();
    const dataDir = await createTempDir("funclaw-hub-test.");
    cleanups.push(() => removeDirWithRetry(dataDir));
    const hub = await startFunclawHubServer({
      host: "127.0.0.1",
      port,
      token: "hub-secret",
      dataDir,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    cleanups.push(() => hub.close("test done"));
    const worker = await connectWorker({ port, token: "hub-secret" });
    cleanups.push(async () => worker.close());

    const bigPayload = Buffer.alloc(1_100_000, 7).toString("base64");
    worker.send(
      JSON.stringify({
        type: "req",
        id: "artifact-1",
        method: "artifact.register",
        params: {
          request_id: "request-1",
          artifact: {
            kind: "file",
            filename: "payload.bin",
            mime_type: "application/octet-stream",
            content_base64: bigPayload,
          },
        },
      }),
    );
    const artifactRes = (await new Promise<{
      ok?: boolean;
      payload?: { transport?: string; artifact_id?: string };
    }>((resolve) =>
      worker.once("message", (raw) => resolve(JSON.parse(rawDataToString(raw)))),
    )) as {
      ok?: boolean;
      payload?: { transport?: string; artifact_id?: string };
    };
    expect(artifactRes.ok).toBe(true);
    expect(artifactRes.payload?.transport).toBe("hub_file");
    const artifactId = artifactRes.payload?.artifact_id;
    expect(typeof artifactId).toBe("string");

    const descriptorRes = await authedFetch(port, `/api/v1/artifacts/${artifactId}`);
    expect(descriptorRes.status).toBe(200);

    const contentRes = await authedFetch(port, `/api/v1/artifacts/${artifactId}/content`);
    expect(contentRes.status).toBe(200);
    const raw = Buffer.from(await contentRes.arrayBuffer());
    expect(raw.byteLength).toBe(1_100_000);
  });

  it("keeps sticky session routing and fails new requests when the bound worker is offline", async () => {
    const port = await getFreePort();
    const dataDir = await createTempDir("funclaw-hub-test.");
    cleanups.push(() => removeDirWithRetry(dataDir));
    const hub = await startFunclawHubServer({
      host: "127.0.0.1",
      port,
      token: "hub-secret",
      dataDir,
      publicBaseUrl: `http://127.0.0.1:${port}`,
    });
    cleanups.push(() => hub.close("test done"));
    const worker = await connectWorker({ port, token: "hub-secret", workerId: "worker-sticky" });

    const sessionRes = await authedFetch(port, "/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session-sticky", adapter_id: "adapter-a" }),
    });
    const sessionJson = (await sessionRes.json()) as { session: { worker_id: string } };
    expect(sessionJson.session.worker_id).toBe("worker-sticky");

    worker.close();
    await once(worker, "close");

    const messageRes = await authedFetch(port, "/api/v1/sessions/session-sticky/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "responses.create", input: { input: "retry" } }),
    });
    expect(messageRes.status).toBe(503);
  });
});

import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { startFunclawHubServer } from "../hub/server.js";
import { startFunclawWorker } from "./run.js";

async function getFreePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function authedFetch(port: number, path: string, init?: RequestInit, token = "hub-secret") {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers,
  });
}

describe("funclaw worker", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("bridges responses.create and session.history.get through the hub", async () => {
    const openclawPort = await getFreePort();
    const openclaw = createServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/v1/responses") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ output_text: "hello from mock openclaw" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/sessions/")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ history: [{ role: "assistant", text: "history item" }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    openclaw.listen(openclawPort, "127.0.0.1");
    await once(openclaw, "listening");
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) => openclaw.close((error) => (error ? reject(error) : resolve()))),
    );

    const hubPort = await getFreePort();
    const hub = await startFunclawHubServer({
      host: "127.0.0.1",
      port: hubPort,
      token: "hub-secret",
      publicBaseUrl: `http://127.0.0.1:${hubPort}`,
    });
    cleanups.push(() => hub.close("test done"));

    const worker = await startFunclawWorker({
      hubUrl: `ws://127.0.0.1:${hubPort}/ws`,
      hubToken: "hub-secret",
      workerId: "worker-1",
      gatewayBaseUrl: `http://127.0.0.1:${openclawPort}`,
    });
    cleanups.push(() => worker.close());

    let workersJson: { workers: unknown[] } = { workers: [] };
    for (let i = 0; i < 20; i += 1) {
      const workersRes = await authedFetch(hubPort, "/api/v1/workers");
      workersJson = (await workersRes.json()) as { workers: unknown[] };
      if (workersJson.workers.length > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(workersJson.workers.length).toBeGreaterThan(0);

    await authedFetch(hubPort, "/api/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session-1", adapter_id: "adapter-a" }),
    });

    const messageRes = await authedFetch(hubPort, "/api/v1/sessions/session-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "responses.create",
        input: { model: "openclaw", input: "hi" },
      }),
    });
    const messageJson = (await messageRes.json()) as { request: { request_id: string } };
    const awaitRes = await authedFetch(hubPort, `/api/v1/requests/${messageJson.request.request_id}/await`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout_ms: 5000 }),
    });
    expect(awaitRes.status).toBe(200);
    const awaitJson = (await awaitRes.json()) as { request: { result: { output_text: string } } };
    expect(awaitJson.request.result.output_text).toBe("hello from mock openclaw");

    const historyRes = await authedFetch(hubPort, "/api/v1/sessions/session-1/history");
    expect(historyRes.status).toBe(200);
    const historyJson = (await historyRes.json()) as { result: { history: Array<{ text: string }> } };
    expect(historyJson.result.history[0]?.text).toBe("history item");
  });
});

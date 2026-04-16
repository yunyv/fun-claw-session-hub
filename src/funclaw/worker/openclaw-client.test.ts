import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WorkerOpenClawClient } from "./openclaw-client.js";

async function listenServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe("WorkerOpenClawClient", () => {
  it("sends operator.write scope and session key when creating responses", async () => {
    let seenAuth = "";
    let seenScopes = "";
    let seenSessionKey = "";
    let seenBody = "";
    const { server, baseUrl } = await listenServer(async (req, res) => {
      seenAuth = String(req.headers.authorization ?? "");
      seenScopes = String(req.headers["x-openclaw-scopes"] ?? "");
      seenSessionKey = String(req.headers["x-openclaw-session-key"] ?? "");
      seenBody = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ output_text: "hello" }));
    });

    try {
      const client = new WorkerOpenClawClient({
        gatewayBaseUrl: baseUrl,
        gatewayToken: "gateway-secret",
      });
      const result = await client.createResponse(
        { model: "openclaw", input: "hi", stream: false },
        "funclaw:conversation-123",
      );
      expect(result).toEqual({ output_text: "hello" });
      expect(seenAuth).toBe("Bearer gateway-secret");
      expect(seenScopes).toBe("operator.write");
      expect(seenSessionKey).toBe("funclaw:conversation-123");
      expect(seenBody).toContain("\"model\":\"openclaw\"");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("sends operator.read scope when loading session history", async () => {
    let seenAuth = "";
    let seenScopes = "";
    let seenPath = "";
    const { server, baseUrl } = await listenServer((req, res) => {
      seenAuth = String(req.headers.authorization ?? "");
      seenScopes = String(req.headers["x-openclaw-scopes"] ?? "");
      seenPath = String(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ history: [] }));
    });

    try {
      const client = new WorkerOpenClawClient({
        gatewayBaseUrl: baseUrl,
        gatewayToken: "gateway-secret",
      });
      const result = await client.getSessionHistory("session-1", { limit: 20, cursor: "abc" });
      expect(result).toEqual({ history: [] });
      expect(seenAuth).toBe("Bearer gateway-secret");
      expect(seenScopes).toBe("operator.read");
      expect(seenPath).toContain("/sessions/session-1/history");
      expect(seenPath).toContain("limit=20");
      expect(seenPath).toContain("cursor=abc");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

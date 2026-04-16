import path from "node:path";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";

export type WorkerOpenClawClientOptions = {
  gatewayBaseUrl: string;
  gatewayToken?: string;
  gatewayWsUrl?: string;
};

const OPERATOR_READ_SCOPE = "operator.read";
const OPERATOR_WRITE_SCOPE = "operator.write";

function buildGatewayHeaders(opts: {
  token?: string;
  scopes?: string[];
  contentType?: string;
  sessionKey?: string;
}): HeadersInit {
  const headers: Record<string, string> = {};
  if (opts.contentType) {
    headers["content-type"] = opts.contentType;
  }
  if (opts.token) {
    headers.authorization = `Bearer ${opts.token}`;
  }
  if (opts.scopes?.length) {
    headers["x-openclaw-scopes"] = opts.scopes.join(",");
  }
  if (opts.sessionKey?.trim()) {
    headers["x-openclaw-session-key"] = opts.sessionKey.trim();
  }
  return headers;
}

function buildWriteHeaders(token?: string): HeadersInit {
  if (!token) {
    return { "content-type": "application/json" };
  }
  return buildGatewayHeaders({
    token,
    scopes: [OPERATOR_WRITE_SCOPE],
    contentType: "application/json",
  });
}

function detectArtifactKind(mimeType: string): "image" | "video" | "audio" | "file" {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

function mimeTypeFromFormat(format: string): string {
  const normalized = format.trim().toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") {
    return "image/jpeg";
  }
  if (normalized === "png") {
    return "image/png";
  }
  if (normalized === "mp4") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

export class WorkerOpenClawClient {
  constructor(private readonly opts: WorkerOpenClawClientOptions) {}

  async createResponse(input: unknown, sessionKey?: string) {
    const res = await fetch(`${this.opts.gatewayBaseUrl}/v1/responses`, {
      method: "POST",
      headers: buildGatewayHeaders({
        token: this.opts.gatewayToken,
        scopes: [OPERATOR_WRITE_SCOPE],
        contentType: "application/json",
        sessionKey,
      }),
      body: JSON.stringify(input),
    });
    const payload = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(`OpenClaw /v1/responses failed: ${res.status} ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  async getSessionHistory(sessionKey: string, query: Record<string, unknown>) {
    const url = new URL(
      `${this.opts.gatewayBaseUrl}/sessions/${encodeURIComponent(sessionKey)}/history`,
    );
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        url.searchParams.set(key, String(value));
      }
    }
    const headers = this.opts.gatewayToken
      ? buildGatewayHeaders({
          token: this.opts.gatewayToken,
          scopes: [OPERATOR_READ_SCOPE],
        })
      : undefined;
    const res = await fetch(url, { headers });
    const payload = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(`OpenClaw history failed: ${res.status} ${JSON.stringify(payload)}`);
    }
    return payload;
  }

  async invokeNode(input: unknown) {
    return await callGateway({
      url: this.opts.gatewayWsUrl,
      token: this.opts.gatewayToken,
      method: "node.invoke",
      params: input,
      scopes: [OPERATOR_WRITE_SCOPE],
      timeoutMs: 30_000,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
  }

  normalizeNodeArtifacts(result: unknown): {
    result: unknown;
    artifacts: Array<{
      kind: "image" | "video" | "audio" | "file";
      filename: string;
      mimeType: string;
      contentBase64: string;
      meta?: Record<string, unknown>;
    }>;
  } {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { result, artifacts: [] };
    }
    const record = { ...(result as Record<string, unknown>) };
    const base64 = typeof record.base64 === "string" ? record.base64 : "";
    if (!base64) {
      return { result, artifacts: [] };
    }
    const format = typeof record.format === "string" ? record.format : "bin";
    const mimeType =
      typeof record.mimeType === "string" && record.mimeType.trim()
        ? record.mimeType
        : mimeTypeFromFormat(format);
    delete record.base64;
    return {
      result: record,
      artifacts: [
        {
          kind: detectArtifactKind(mimeType),
          filename: `node-output.${path.extname(`.${format}`).slice(1) || format}`,
          mimeType,
          contentBase64: base64,
          meta: {
            format,
          },
        },
      ],
    };
  }
}

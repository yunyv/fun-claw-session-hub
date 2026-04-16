import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createAsyncLock, readJsonFile, writeJsonAtomic } from "../../infra/json-files.js";
import {
  MAX_INLINE_ARTIFACT_BYTES,
  type ArtifactDescriptor,
  type ErrorShape,
  type RequestRecord,
  type SessionRouteRecord,
} from "../contracts/index.js";
import {
  resolveHubArtifactsDir,
  resolveHubArtifactsIndexPath,
  resolveHubRequestsPath,
  resolveHubSessionsPath,
} from "./paths.js";

export type ConnectedWorkerState = {
  workerId: string;
  hostname: string;
  version: string;
  capabilities: string[];
  connectedAt: string;
  lastHeartbeatAt: string;
};

export type RegisterArtifactInput = {
  requestId: string;
  kind: ArtifactDescriptor["kind"];
  filename: string;
  mimeType: string;
  contentBase64: string;
  meta?: Record<string, unknown>;
};

type PersistedArtifactIndex = Record<string, ArtifactDescriptor>;
type PersistedSessions = Record<string, SessionRouteRecord>;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeFileName(fileName: string): string {
  const trimmed = fileName.trim();
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return safe || "artifact.bin";
}

async function appendJsonlLine(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function readJsonlLatestByRequestId(filePath: string): Promise<Map<string, RequestRecord>> {
  const out = new Map<string, RequestRecord>();
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as RequestRecord;
      if (typeof parsed.request_id === "string" && parsed.request_id) {
        out.set(parsed.request_id, parsed);
      }
    } catch {
      // Keep startup resilient if one line is malformed.
    }
  }
  return out;
}

export class FunclawHubStore {
  private readonly lock = createAsyncLock();
  private readonly sessions = new Map<string, SessionRouteRecord>();
  private readonly requests = new Map<string, RequestRecord>();
  private readonly artifacts = new Map<string, ArtifactDescriptor>();
  private readonly workers = new Map<string, ConnectedWorkerState>();

  constructor(
    private readonly dataDir: string,
    private readonly publicBaseUrl: string,
  ) {}

  async load() {
    const [sessions, artifacts, requests] = await Promise.all([
      readJsonFile<PersistedSessions>(resolveHubSessionsPath(this.dataDir)),
      readJsonFile<PersistedArtifactIndex>(resolveHubArtifactsIndexPath(this.dataDir)),
      readJsonlLatestByRequestId(resolveHubRequestsPath(this.dataDir)),
    ]);
    for (const entry of Object.values(sessions ?? {})) {
      this.sessions.set(entry.session_id, entry);
    }
    for (const entry of Object.values(artifacts ?? {})) {
      this.artifacts.set(entry.artifact_id, entry);
    }
    for (const [requestId, entry] of requests) {
      this.requests.set(requestId, entry);
    }
  }

  listWorkers(): ConnectedWorkerState[] {
    return [...this.workers.values()].toSorted((a, b) => a.workerId.localeCompare(b.workerId));
  }

  addWorker(worker: ConnectedWorkerState) {
    this.workers.set(worker.workerId, worker);
  }

  markWorkerHeartbeat(workerId: string) {
    const current = this.workers.get(workerId);
    if (!current) {
      return;
    }
    this.workers.set(workerId, {
      ...current,
      lastHeartbeatAt: nowIso(),
    });
  }

  removeWorker(workerId: string) {
    this.workers.delete(workerId);
    for (const entry of this.sessions.values()) {
      if (entry.worker_id === workerId) {
        entry.status = "worker_offline";
      }
    }
    void this.persistSessions();
  }

  getSession(sessionId: string): SessionRouteRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getRequest(requestId: string): RequestRecord | undefined {
    return this.requests.get(requestId);
  }

  getArtifact(artifactId: string): ArtifactDescriptor | undefined {
    return this.artifacts.get(artifactId);
  }

  resolveArtifactFilePath(artifactId: string, fileName: string): string {
    return path.join(resolveHubArtifactsDir(this.dataDir), `${artifactId}-${sanitizeFileName(fileName)}`);
  }

  async ensureSession(params: {
    sessionId: string;
    adapterId: string;
    openclawSessionKey: string;
  }): Promise<SessionRouteRecord> {
    return await this.lock(async () => {
      const existing = this.sessions.get(params.sessionId);
      if (existing) {
        existing.last_seen_at = nowIso();
        if (existing.status === "worker_offline" && this.workers.has(existing.worker_id)) {
          existing.status = "bound";
        }
        await this.persistSessions();
        return existing;
      }
      const selected = this.selectWorkerForNewSession();
      const createdAt = nowIso();
      const entry: SessionRouteRecord = {
        session_id: params.sessionId,
        worker_id: selected.workerId,
        adapter_id: params.adapterId,
        openclaw_session_key: params.openclawSessionKey,
        status: "bound",
        created_at: createdAt,
        last_seen_at: createdAt,
      };
      this.sessions.set(entry.session_id, entry);
      await this.persistSessions();
      return entry;
    });
  }

  async createRequest(params: {
    requestId?: string;
    session: SessionRouteRecord;
    action: RequestRecord["action"];
    input: unknown;
  }): Promise<RequestRecord> {
    return await this.lock(async () => {
      const now = nowIso();
      const entry: RequestRecord = {
        request_id: params.requestId?.trim() || randomUUID(),
        session_id: params.session.session_id,
        worker_id: params.session.worker_id,
        adapter_id: params.session.adapter_id,
        openclaw_session_key: params.session.openclaw_session_key,
        action: params.action,
        input: params.input,
        status: "queued",
        created_at: now,
        updated_at: now,
        outputs: [],
        artifacts: [],
      };
      this.requests.set(entry.request_id, entry);
      params.session.last_seen_at = now;
      params.session.last_request_id = entry.request_id;
      await Promise.all([this.persistSessions(), this.appendRequest(entry)]);
      return entry;
    });
  }

  async markAccepted(requestId: string, acceptedAt: string) {
    await this.updateRequest(requestId, (entry) => {
      entry.status = "running";
      entry.accepted_at = acceptedAt;
      entry.updated_at = acceptedAt;
    });
  }

  async appendOutput(requestId: string, output: RequestRecord["outputs"][number]) {
    await this.updateRequest(requestId, (entry) => {
      entry.outputs.push(output);
      entry.updated_at = output.emitted_at;
    });
  }

  async markCompleted(requestId: string, result: unknown, artifacts: ArtifactDescriptor[], completedAt: string) {
    await this.updateRequest(requestId, (entry) => {
      entry.status = "completed";
      entry.result = result;
      entry.artifacts = artifacts;
      entry.finished_at = completedAt;
      entry.updated_at = completedAt;
    });
  }

  async markFailed(requestId: string, error: ErrorShape, failedAt: string) {
    await this.updateRequest(requestId, (entry) => {
      entry.status = "failed";
      entry.error = error;
      entry.finished_at = failedAt;
      entry.updated_at = failedAt;
    });
  }

  async registerArtifact(input: RegisterArtifactInput): Promise<ArtifactDescriptor> {
    return await this.lock(async () => {
      const raw = Buffer.from(input.contentBase64, "base64");
      const sha256 = createHash("sha256").update(raw).digest("hex");
      const artifactId = randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      let descriptor: ArtifactDescriptor;
      if (raw.byteLength <= MAX_INLINE_ARTIFACT_BYTES) {
        descriptor = {
          artifact_id: artifactId,
          kind: input.kind,
          filename: sanitizeFileName(input.filename),
          mime_type: input.mimeType,
          size_bytes: raw.byteLength,
          sha256,
          transport: "inline",
          inline_base64: input.contentBase64,
          expires_at: expiresAt,
          meta: input.meta,
        };
      } else {
        const fileName = sanitizeFileName(input.filename);
        const filePath = this.resolveArtifactFilePath(artifactId, fileName);
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await fs.writeFile(filePath, raw, { mode: 0o600 });
        descriptor = {
          artifact_id: artifactId,
          kind: input.kind,
          filename: fileName,
          mime_type: input.mimeType,
          size_bytes: raw.byteLength,
          sha256,
          transport: "hub_file",
          download_url: `${this.publicBaseUrl}/api/v1/artifacts/${artifactId}/content`,
          expires_at: expiresAt,
          meta: input.meta,
        };
      }
      this.artifacts.set(descriptor.artifact_id, descriptor);
      await this.persistArtifacts();
      return descriptor;
    });
  }

  private selectWorkerForNewSession(): ConnectedWorkerState {
    const workers = this.listWorkers();
    const selected = workers[0];
    if (!selected) {
      throw new Error("No online worker available");
    }
    return selected;
  }

  private async updateRequest(requestId: string, mutate: (entry: RequestRecord) => void) {
    await this.lock(async () => {
      const entry = this.requests.get(requestId);
      if (!entry) {
        throw new Error(`Unknown request: ${requestId}`);
      }
      mutate(entry);
      await this.appendRequest(entry);
    });
  }

  private async appendRequest(entry: RequestRecord) {
    await appendJsonlLine(resolveHubRequestsPath(this.dataDir), entry);
  }

  private async persistSessions() {
    const persisted = Object.fromEntries([...this.sessions.values()].map((entry) => [entry.session_id, entry]));
    await writeJsonAtomic(resolveHubSessionsPath(this.dataDir), persisted, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  }

  private async persistArtifacts() {
    const persisted = Object.fromEntries([...this.artifacts.values()].map((entry) => [entry.artifact_id, entry]));
    await writeJsonAtomic(resolveHubArtifactsIndexPath(this.dataDir), persisted, {
      mode: 0o600,
      trailingNewline: true,
      ensureDirMode: 0o700,
    });
  }
}


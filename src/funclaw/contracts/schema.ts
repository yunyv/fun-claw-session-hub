import { Type, type Static } from "@sinclair/typebox";

const NonEmptyString = Type.String({ minLength: 1 });
const PositiveInteger = Type.Integer({ minimum: 0 });

export const HubClientSchema = Type.Object(
  {
    id: NonEmptyString,
    version: NonEmptyString,
    platform: NonEmptyString,
    mode: NonEmptyString,
    displayName: Type.Optional(NonEmptyString),
    instanceId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const WorkerRegistrationSchema = Type.Object(
  {
    worker_id: NonEmptyString,
    tenant_id: Type.Optional(NonEmptyString),
    env: Type.Optional(NonEmptyString),
    hostname: NonEmptyString,
    version: NonEmptyString,
    capabilities: Type.Array(NonEmptyString, { default: [] }),
  },
  { additionalProperties: false },
);

export const AdapterRegistrationSchema = Type.Object(
  {
    adapter_id: NonEmptyString,
    tenant_id: Type.Optional(NonEmptyString),
    env: Type.Optional(NonEmptyString),
    hostname: Type.Optional(NonEmptyString),
    version: NonEmptyString,
  },
  { additionalProperties: false },
);

export const HubConnectParamsSchema = Type.Object(
  {
    minProtocol: PositiveInteger,
    maxProtocol: PositiveInteger,
    client: HubClientSchema,
    role: Type.Union([Type.Literal("worker"), Type.Literal("adapter")]),
    auth: Type.Optional(
      Type.Object(
        {
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    nonce: NonEmptyString,
    worker: Type.Optional(WorkerRegistrationSchema),
    adapter: Type.Optional(AdapterRegistrationSchema),
  },
  { additionalProperties: false },
);

export const HubHelloOkSchema = Type.Object(
  {
    type: Type.Literal("hello-ok"),
    protocol: PositiveInteger,
    server: Type.Object(
      {
        version: NonEmptyString,
        connId: NonEmptyString,
      },
      { additionalProperties: false },
    ),
    policy: Type.Object(
      {
        heartbeatIntervalMs: PositiveInteger,
        maxInlineArtifactBytes: PositiveInteger,
      },
      { additionalProperties: false },
    ),
    features: Type.Object(
      {
        methods: Type.Array(NonEmptyString),
        events: Type.Array(NonEmptyString),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ErrorShapeSchema = Type.Object(
  {
    code: NonEmptyString,
    message: NonEmptyString,
    details: Type.Optional(Type.Unknown()),
    retryable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const HubRequestFrameSchema = Type.Object(
  {
    type: Type.Literal("req"),
    id: NonEmptyString,
    method: NonEmptyString,
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const HubResponseFrameSchema = Type.Object(
  {
    type: Type.Literal("res"),
    id: NonEmptyString,
    ok: Type.Boolean(),
    payload: Type.Optional(Type.Unknown()),
    error: Type.Optional(ErrorShapeSchema),
  },
  { additionalProperties: false },
);

export const HubEventFrameSchema = Type.Object(
  {
    type: Type.Literal("event"),
    event: NonEmptyString,
    payload: Type.Optional(Type.Unknown()),
    seq: Type.Optional(PositiveInteger),
  },
  { additionalProperties: false },
);

export const HubFrameSchema = Type.Union(
  [HubRequestFrameSchema, HubResponseFrameSchema, HubEventFrameSchema],
  { discriminator: "type" },
);

export const TaskActionSchema = Type.Union([
  Type.Literal("responses.create"),
  Type.Literal("agent"),
  Type.Literal("session.history.get"),
  Type.Literal("node.invoke"),
]);

export const ArtifactTransportSchema = Type.Union([
  Type.Literal("inline"),
  Type.Literal("hub_file"),
  Type.Literal("object_store"),
]);

export const ArtifactKindSchema = Type.Union([
  Type.Literal("image"),
  Type.Literal("video"),
  Type.Literal("audio"),
  Type.Literal("file"),
  Type.Literal("json"),
]);

export const ArtifactDescriptorSchema = Type.Object(
  {
    artifact_id: NonEmptyString,
    kind: ArtifactKindSchema,
    filename: NonEmptyString,
    mime_type: NonEmptyString,
    size_bytes: PositiveInteger,
    sha256: NonEmptyString,
    transport: ArtifactTransportSchema,
    inline_base64: Type.Optional(Type.String()),
    download_url: Type.Optional(Type.String()),
    expires_at: Type.Optional(Type.String({ format: "date-time" })),
    meta: Type.Optional(Type.Record(NonEmptyString, Type.Unknown())),
  },
  { additionalProperties: false },
);

export const ArtifactRegisterParamsSchema = Type.Object(
  {
    request_id: NonEmptyString,
    artifact: Type.Object(
      {
        kind: ArtifactKindSchema,
        filename: NonEmptyString,
        mime_type: NonEmptyString,
        content_base64: NonEmptyString,
        meta: Type.Optional(Type.Record(NonEmptyString, Type.Unknown())),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const TaskAssignedPayloadSchema = Type.Object(
  {
    request_id: NonEmptyString,
    session_id: NonEmptyString,
    worker_id: NonEmptyString,
    adapter_id: NonEmptyString,
    openclaw_session_key: NonEmptyString,
    action: TaskActionSchema,
    input: Type.Unknown(),
    created_at: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const TaskAcceptedPayloadSchema = Type.Object(
  {
    request_id: NonEmptyString,
    accepted_at: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const TaskOutputPayloadSchema = Type.Object(
  {
    request_id: NonEmptyString,
    output_index: PositiveInteger,
    output: Type.Unknown(),
    emitted_at: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const TaskCompletedPayloadSchema = Type.Object(
  {
    request_id: NonEmptyString,
    completed_at: Type.String({ format: "date-time" }),
    result: Type.Unknown(),
    artifacts: Type.Array(ArtifactDescriptorSchema, { default: [] }),
  },
  { additionalProperties: false },
);

export const TaskFailedPayloadSchema = Type.Object(
  {
    request_id: NonEmptyString,
    failed_at: Type.String({ format: "date-time" }),
    error: ErrorShapeSchema,
  },
  { additionalProperties: false },
);

export const WorkerHeartbeatPayloadSchema = Type.Object(
  {
    worker_id: NonEmptyString,
    ts: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const SessionRouteStatusSchema = Type.Union([
  Type.Literal("bound"),
  Type.Literal("worker_offline"),
]);

export const SessionRouteRecordSchema = Type.Object(
  {
    session_id: NonEmptyString,
    worker_id: NonEmptyString,
    adapter_id: NonEmptyString,
    openclaw_session_key: NonEmptyString,
    status: SessionRouteStatusSchema,
    created_at: Type.String({ format: "date-time" }),
    last_seen_at: Type.String({ format: "date-time" }),
    last_request_id: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const RequestStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("canceled"),
]);

export const RequestRecordSchema = Type.Object(
  {
    request_id: NonEmptyString,
    session_id: NonEmptyString,
    worker_id: NonEmptyString,
    adapter_id: NonEmptyString,
    openclaw_session_key: NonEmptyString,
    action: TaskActionSchema,
    input: Type.Unknown(),
    status: RequestStatusSchema,
    created_at: Type.String({ format: "date-time" }),
    updated_at: Type.String({ format: "date-time" }),
    accepted_at: Type.Optional(Type.String({ format: "date-time" })),
    finished_at: Type.Optional(Type.String({ format: "date-time" })),
    outputs: Type.Array(TaskOutputPayloadSchema, { default: [] }),
    result: Type.Optional(Type.Unknown()),
    artifacts: Type.Array(ArtifactDescriptorSchema, { default: [] }),
    error: Type.Optional(ErrorShapeSchema),
  },
  { additionalProperties: false },
);

export const CreateSessionBodySchema = Type.Object(
  {
    session_id: NonEmptyString,
    adapter_id: Type.Optional(NonEmptyString),
    openclaw_session_key: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const PostSessionMessageBodySchema = Type.Object(
  {
    request_id: Type.Optional(NonEmptyString),
    adapter_id: Type.Optional(NonEmptyString),
    openclaw_session_key: Type.Optional(NonEmptyString),
    action: TaskActionSchema,
    input: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const AwaitRequestBodySchema = Type.Object(
  {
    timeout_ms: Type.Optional(PositiveInteger),
  },
  { additionalProperties: false },
);

export type HubClient = Static<typeof HubClientSchema>;
export type WorkerRegistration = Static<typeof WorkerRegistrationSchema>;
export type AdapterRegistration = Static<typeof AdapterRegistrationSchema>;
export type HubConnectParams = Static<typeof HubConnectParamsSchema>;
export type HubHelloOk = Static<typeof HubHelloOkSchema>;
export type ErrorShape = Static<typeof ErrorShapeSchema>;
export type HubRequestFrame = Static<typeof HubRequestFrameSchema>;
export type HubResponseFrame = Static<typeof HubResponseFrameSchema>;
export type HubEventFrame = Static<typeof HubEventFrameSchema>;
export type HubFrame = Static<typeof HubFrameSchema>;
export type ArtifactDescriptor = Static<typeof ArtifactDescriptorSchema>;
export type ArtifactRegisterParams = Static<typeof ArtifactRegisterParamsSchema>;
export type TaskAssignedPayload = Static<typeof TaskAssignedPayloadSchema>;
export type TaskAcceptedPayload = Static<typeof TaskAcceptedPayloadSchema>;
export type TaskOutputPayload = Static<typeof TaskOutputPayloadSchema>;
export type TaskCompletedPayload = Static<typeof TaskCompletedPayloadSchema>;
export type TaskFailedPayload = Static<typeof TaskFailedPayloadSchema>;
export type WorkerHeartbeatPayload = Static<typeof WorkerHeartbeatPayloadSchema>;
export type SessionRouteRecord = Static<typeof SessionRouteRecordSchema>;
export type RequestRecord = Static<typeof RequestRecordSchema>;
export type CreateSessionBody = Static<typeof CreateSessionBodySchema>;
export type PostSessionMessageBody = Static<typeof PostSessionMessageBodySchema>;
export type AwaitRequestBody = Static<typeof AwaitRequestBodySchema>;

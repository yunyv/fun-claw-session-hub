import AjvPkg from "ajv";
import { HUB_DEFAULT_HEARTBEAT_INTERVAL_MS, HUB_PROTOCOL_VERSION, MAX_INLINE_ARTIFACT_BYTES } from "./constants.js";
import {
  ArtifactDescriptorSchema,
  ArtifactRegisterParamsSchema,
  AwaitRequestBodySchema,
  CreateSessionBodySchema,
  ErrorShapeSchema,
  HubConnectParamsSchema,
  HubEventFrameSchema,
  HubFrameSchema,
  HubHelloOkSchema,
  HubRequestFrameSchema,
  HubResponseFrameSchema,
  PostSessionMessageBodySchema,
  RequestRecordSchema,
  SessionRouteRecordSchema,
  TaskAcceptedPayloadSchema,
  TaskAssignedPayloadSchema,
  TaskCompletedPayloadSchema,
  TaskFailedPayloadSchema,
  TaskOutputPayloadSchema,
  WorkerHeartbeatPayloadSchema,
} from "./schema.js";

export * from "./constants.js";
export * from "./schema.js";

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
  validateFormats: false,
});

export const validateHubConnectParams = ajv.compile(HubConnectParamsSchema);
export const validateHubRequestFrame = ajv.compile(HubRequestFrameSchema);
export const validateHubResponseFrame = ajv.compile(HubResponseFrameSchema);
export const validateHubEventFrame = ajv.compile(HubEventFrameSchema);
export const validateHubFrame = ajv.compile(HubFrameSchema);
export const validateHubHelloOk = ajv.compile(HubHelloOkSchema);
export const validateErrorShape = ajv.compile(ErrorShapeSchema);
export const validateTaskAssignedPayload = ajv.compile(TaskAssignedPayloadSchema);
export const validateTaskAcceptedPayload = ajv.compile(TaskAcceptedPayloadSchema);
export const validateTaskOutputPayload = ajv.compile(TaskOutputPayloadSchema);
export const validateTaskCompletedPayload = ajv.compile(TaskCompletedPayloadSchema);
export const validateTaskFailedPayload = ajv.compile(TaskFailedPayloadSchema);
export const validateWorkerHeartbeatPayload = ajv.compile(WorkerHeartbeatPayloadSchema);
export const validateArtifactDescriptor = ajv.compile(ArtifactDescriptorSchema);
export const validateArtifactRegisterParams = ajv.compile(ArtifactRegisterParamsSchema);
export const validateSessionRouteRecord = ajv.compile(SessionRouteRecordSchema);
export const validateRequestRecord = ajv.compile(RequestRecordSchema);
export const validateCreateSessionBody = ajv.compile(CreateSessionBodySchema);
export const validatePostSessionMessageBody = ajv.compile(PostSessionMessageBodySchema);
export const validateAwaitRequestBody = ajv.compile(AwaitRequestBodySchema);

export function buildHubHelloOk(connId: string, version: string) {
  return {
    type: "hello-ok" as const,
    protocol: HUB_PROTOCOL_VERSION,
    server: {
      version,
      connId,
    },
    policy: {
      heartbeatIntervalMs: HUB_DEFAULT_HEARTBEAT_INTERVAL_MS,
      maxInlineArtifactBytes: MAX_INLINE_ARTIFACT_BYTES,
    },
    features: {
      methods: [
        "connect",
        "worker.heartbeat",
        "task.accepted",
        "task.output",
        "task.completed",
        "task.failed",
        "artifact.register",
      ],
      events: ["connect.challenge", "task.assigned", "task.cancel"],
    },
  };
}

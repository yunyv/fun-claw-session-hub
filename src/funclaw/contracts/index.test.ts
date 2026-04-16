import { describe, expect, it } from "vitest";
import {
  HUB_PROTOCOL_VERSION,
  MAX_INLINE_ARTIFACT_BYTES,
  buildHubHelloOk,
  validateHubHelloOk,
} from "./index.js";

describe("funclaw contracts", () => {
  it("builds a valid hello-ok payload", () => {
    const hello = buildHubHelloOk("conn-1", "1.2.3");
    expect(validateHubHelloOk(hello)).toBe(true);
    expect(hello.protocol).toBe(HUB_PROTOCOL_VERSION);
    expect(hello.policy.maxInlineArtifactBytes).toBe(MAX_INLINE_ARTIFACT_BYTES);
  });
});


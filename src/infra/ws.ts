import { Buffer } from "node:buffer";
import type { RawData } from "ws";

export function rawDataToString(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf-8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf-8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf-8");
  }
  return Buffer.from(raw).toString("utf-8");
}

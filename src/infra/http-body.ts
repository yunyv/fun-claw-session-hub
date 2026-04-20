import type { IncomingMessage } from "node:http";

export type ReadJsonBodyWithLimitOptions = {
  maxBytes: number;
  timeoutMs: number;
};

export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: Error };

export async function readJsonBodyWithLimit(
  req: IncomingMessage,
  opts: ReadJsonBodyWithLimitOptions,
): Promise<ReadJsonBodyResult> {
  return await new Promise<ReadJsonBodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (result: ReadJsonBodyResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > opts.maxBytes) {
        finish({ ok: false, error: new Error(`Request body exceeded ${opts.maxBytes} bytes`) });
        req.destroy();
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch (error) {
        finish({
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    };

    const onError = (error: Error) => {
      finish({ ok: false, error });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: new Error(`Timed out after ${opts.timeoutMs}ms`) });
      req.destroy();
    }, opts.timeoutMs);

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

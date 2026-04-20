import type { ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function sendText(res: ServerResponse, status: number, text: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

export function sendMethodNotAllowed(res: ServerResponse, allow: string) {
  res.statusCode = 405;
  res.setHeader("Allow", allow);
  sendJson(res, 405, {
    ok: false,
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: `Method not allowed. Expected ${allow}`,
    },
  });
}

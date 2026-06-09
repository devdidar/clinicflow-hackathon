import type { Response } from "express";

export function openSse(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

export function sendSse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function extractTextDelta(event: unknown): string {
  const raw = event as {
    type?: string;
    data?: { event?: { type?: string; delta?: string }; type?: string; delta?: string };
  };

  const payload = raw.data?.event ?? raw.data;
  if (raw.type === "raw_model_stream_event" && payload?.type === "response.output_text.delta") {
    return payload.delta ?? "";
  }

  return "";
}

export function extractRunItemToolLabel(event: unknown): string | null {
  const raw = event as {
    type?: string;
    item?: { type?: string; rawItem?: { name?: string; type?: string }; name?: string };
    data?: { item?: { type?: string; rawItem?: { name?: string; type?: string }; name?: string } };
  };
  if (raw.type !== "run_item_stream_event") return null;
  const item = raw.item ?? raw.data?.item;
  const type = item?.type ?? item?.rawItem?.type ?? "";
  if (!/tool/i.test(type)) return null;
  return item?.name ?? item?.rawItem?.name ?? type;
}

import { WebSocket } from "ws";

export const FRAME_SPECTRUM = 0x01;
export const FRAME_AUDIO = 0x02;
export const FRAME_BAND = 0x03;

export class StreamHub {
  private clients = new Set<WebSocket>();
  onEmpty: (() => void) | null = null;

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.remove(ws));
    ws.on("error", () => this.remove(ws));
  }

  private remove(ws: WebSocket): void {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.onEmpty?.();
  }

  get size(): number {
    return this.clients.size;
  }

  broadcastJson(obj: unknown): void {
    const data = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  broadcastFloat32(type: number, payload: Float32Array): void {
    const buf = Buffer.allocUnsafe(8 + payload.length * 4);
    buf.writeUInt8(type, 0);
    buf.writeUInt32LE(payload.length, 4);
    for (let i = 0; i < payload.length; i++) {
      buf.writeFloatLE(payload[i], 8 + i * 4);
    }
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    }
  }
}

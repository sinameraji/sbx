import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Minimal RFC 6455 WebSocket server — just enough to back the dashboard's live
 * terminal without pulling in `ws`. Handles the upgrade handshake, decodes
 * (masked) client frames, encodes (unmasked) server frames, answers pings, and
 * reassembles fragmented messages. Keeps the daemon's zero-runtime-dependency,
 * hand-rolled-server ethos.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WebSocketConnection {
  /** Send a message: Buffer → binary frame, string → text frame. */
  send(data: Buffer | string): void;
  /** Register a handler for inbound messages. */
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void;
  /** Register a handler invoked once when the connection closes. */
  onClose(cb: () => void): void;
  /** Close the connection (sends a close frame). */
  close(): void;
}

/** Complete the WebSocket handshake and return a framed connection, or null. */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): WebSocketConnection | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new Conn(socket, head);
}

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// Inbound messages are terminal keystrokes + resize JSON — tiny. Cap any single
// frame and any reassembled fragmented message so a client can't stream
// unbounded data into the daemon's buffers (memory DoS).
const MAX_MESSAGE_BYTES = 1024 * 1024;

class Conn implements WebSocketConnection {
  private buf = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragOpcode = 0;
  private fragBytes = 0;
  private closed = false;
  private messageCb?: (data: Buffer, isBinary: boolean) => void;
  private closeCb?: () => void;
  // Messages that arrive before a handler is attached (e.g. a client that sends
  // immediately on open while the server is still async-opening the PTY) are
  // queued and flushed once onMessage registers, so no input is dropped.
  private pending: Array<[Buffer, boolean]> = [];

  constructor(private readonly socket: Duplex, head: Buffer) {
    socket.on("data", (d: Buffer) => this.onData(d));
    socket.on("close", () => this.emitClose());
    socket.on("error", () => this.emitClose());
    if (head && head.length) this.onData(head);
  }

  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void {
    this.messageCb = cb;
    const queued = this.pending;
    this.pending = [];
    for (const [data, isBinary] of queued) cb(data, isBinary);
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.parse();
  }

  private parse(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      // Reject an oversized frame before waiting to buffer its payload.
      if (len > MAX_MESSAGE_BYTES) {
        this.close();
        return;
      }
      let maskKey: Buffer | undefined;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return;
      const raw = this.buf.subarray(offset, offset + len);
      const payload = Buffer.allocUnsafe(len);
      if (maskKey) {
        for (let i = 0; i < len; i++) payload[i] = raw[i] ^ maskKey[i & 3];
      } else {
        raw.copy(payload);
      }
      this.buf = this.buf.subarray(offset + len);
      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_CLOSE:
        this.close();
        return;
      case OP_PING:
        this.sendFrame(OP_PONG, payload);
        return;
      case OP_PONG:
        return;
      case OP_CONT:
        this.fragBytes += payload.length;
        if (this.fragBytes > MAX_MESSAGE_BYTES) {
          this.close();
          return;
        }
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = [];
          this.fragOpcode = 0;
          this.fragBytes = 0;
          this.emitMessage(full, op === OP_BINARY);
        }
        return;
      default:
        // TEXT or BINARY
        if (!fin) {
          this.fragOpcode = opcode;
          this.fragments = [payload];
          this.fragBytes = payload.length;
          return;
        }
        this.emitMessage(payload, opcode === OP_BINARY);
    }
  }

  private emitMessage(data: Buffer, isBinary: boolean): void {
    if (this.messageCb) this.messageCb(data, isBinary);
    else this.pending.push([data, isBinary]);
  }

  private emitClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.();
  }

  send(data: Buffer | string): void {
    if (this.closed) return;
    const isBinary = Buffer.isBuffer(data);
    const payload = isBinary ? (data as Buffer) : Buffer.from(data as string, "utf8");
    this.sendFrame(isBinary ? OP_BINARY : OP_TEXT, payload);
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.emitClose();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    try {
      this.sendFrame(OP_CLOSE, Buffer.alloc(0));
      this.socket.end();
    } catch {
      // socket may already be gone
    }
    this.emitClose();
  }
}

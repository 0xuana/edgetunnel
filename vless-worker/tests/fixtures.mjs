import { uuidBytes, joinBytes } from '../src/protocol.mjs';
export const UUID = '00112233-4455-4677-8899-aabbccddeeff';
export const identity = uuidBytes(UUID);
export function requestBytes({ command = 1, port = 443, type = 2, address = new TextEncoder().encode('example.com'), payload = new Uint8Array([7, 8]), options = new Uint8Array() } = {}) {
  return joinBytes(new Uint8Array([0]), identity, new Uint8Array([options.length]), options,
    new Uint8Array([command, port >> 8, port & 255, type]), type === 2 ? new Uint8Array([address.length]) : new Uint8Array(), address, payload);
}
export function mockSocket(onWrite = () => {}) {
  let controller;
  const writes = [];
  let closed = false;
  return {
    writes,
    opened: Promise.resolve(), closed: Promise.resolve(),
    readable: new ReadableStream({ start(c) { controller = c; } }),
    writable: new WritableStream({ write(data) { writes.push(data.slice()); return onWrite(data, controller, writes.length); } }),
    close() { if (!closed) { closed = true; try { controller.close(); } catch {} } },
    get wasClosed() { return closed; },
  };
}
export class MockWebSocket extends EventTarget {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data.slice()); }
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}

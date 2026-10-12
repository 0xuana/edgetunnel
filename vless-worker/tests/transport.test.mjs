import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { openTcp, TunnelSession } from '../src/transport.mjs';
import { parseSocks, parseRequest, joinBytes } from '../src/protocol.mjs';
import { identity, requestBytes, mockSocket, MockWebSocket } from './fixtures.mjs';

const config = { identity, proxy: null, timeoutMs: 1000, doh: 'https://resolver.example/dns-query' };
const destination = parseRequest(requestBytes(), identity);

test('SOCKS5 authentication handles fragmented replies and preserves target bytes', async () => {
  const socket = mockSocket((_, c, step) => {
    const response = step === 1 ? [5, 2] : step === 2 ? [1, 0] : [5, 0, 0, 3, 3, 97, 98, 99, 0, 80, 42, 43];
    if (step < 3) for (const byte of response) c.enqueue(new Uint8Array([byte]));
    else c.enqueue(new Uint8Array(response));
  });
  let address;
  const stream = await openTcp(target => { address = target; return socket; }, destination, parseSocks('socks5://user:pass@proxy.example:1080'));
  assert.deepEqual(address, { hostname: 'proxy.example', port: 1080 });
  assert.deepEqual(socket.writes[0], new Uint8Array([5, 1, 2]));
  assert.equal(new TextDecoder().decode(socket.writes[1].slice(2, 6)), 'user');
  assert.deepEqual(socket.writes[2], joinBytes(new Uint8Array([5, 1, 0, 3, 11]), destination.address, new Uint8Array([1, 187])));
  assert.deepEqual(stream.prefix, new Uint8Array([42, 43]));
  socket.close(); stream.reader.releaseLock(); stream.writer.releaseLock();
});
test('SOCKS5 rejection and timeout close sockets without direct fallback', async () => {
  for (const response of [[5, 255], [4, 0]]) {
    const socket = mockSocket((_, c) => c.enqueue(new Uint8Array(response)));
    await assert.rejects(openTcp(() => socket, destination, parseSocks('proxy.example')), /rejected/);
    assert.equal(socket.wasClosed, true);
  }
  const stalled = mockSocket();
  await assert.rejects(openTcp(() => stalled, destination, parseSocks('proxy.example'), 10), /timed out/);
  assert.equal(stalled.wasClosed, true);
});
test('SOCKS5 credential failure and CONNECT failure are rejected', async () => {
  const badAuth = mockSocket((_, c, step) => c.enqueue(new Uint8Array(step === 1 ? [5, 2] : [1, 1])));
  await assert.rejects(openTcp(() => badAuth, destination, parseSocks('user:pass@proxy.example')), /credentials rejected/);
  const badConnect = mockSocket((_, c, step) => c.enqueue(new Uint8Array(step === 1 ? [5, 0] : [5, 5, 0, 1])));
  await assert.rejects(openTcp(() => badConnect, destination, parseSocks('proxy.example')), /CONNECT rejected/);
});
test('TCP session assembles split handshake and sends response prefix exactly once', async () => {
  const socket = mockSocket((data, c) => c.enqueue(data));
  const ws = new MockWebSocket();
  const session = new TunnelSession(ws, config, () => socket);
  session.start(new Uint8Array());
  const packet = requestBytes();
  ws.message(packet.slice(0, 5)); ws.message(packet.slice(5)); ws.message(new Uint8Array([9]));
  await session.chain; await delay(0);
  assert.deepEqual(socket.writes, [new Uint8Array([7, 8]), new Uint8Array([9])]);
  assert.deepEqual(ws.sent, [new Uint8Array([0, 0, 7, 8]), new Uint8Array([9])]);
  ws.dispatchEvent(new Event('close'));
  assert.equal(socket.wasClosed, true);
  assert.equal(session.stopped, true);
});
test('invalid UUID cannot create an upstream connection', async () => {
  let count = 0;
  const ws = new MockWebSocket(); const session = new TunnelSession(ws, config, () => { count++; });
  session.start(new Uint8Array());
  const packet = requestBytes(); packet[1] ^= 1; ws.message(packet);
  await session.chain;
  assert.equal(count, 0); assert.equal(session.stopped, true);
});
test('client disconnect while connecting closes the pending upstream', async () => {
  const socket = mockSocket();
  socket.opened = delay(20);
  const ws = new MockWebSocket(); const session = new TunnelSession(ws, config, () => socket);
  session.start(requestBytes());
  await delay(0); ws.dispatchEvent(new Event('close')); await session.chain;
  assert.equal(socket.wasClosed, true); assert.deepEqual(socket.writes, []);
});
test('DNS session reassembles split datagrams and frames resolver answers', async () => {
  const ws = new MockWebSocket(); let requests = 0;
  const session = new TunnelSession(ws, config, () => { throw new Error('DNS must not dial TCP'); }, async (url, init) => {
    assert.equal(url, config.doh); assert.equal(init.body.length, 12); requests++;
    return new Response(new Uint8Array(12), { headers: { 'Content-Type': 'application/dns-message' } });
  });
  const frame = joinBytes(new Uint8Array([0, 12]), new Uint8Array(12));
  session.start(requestBytes({ command: 2, port: 53, payload: frame.slice(0, 1) }));
  session.enqueue(frame.slice(1, 7)); session.enqueue(joinBytes(frame.slice(7), frame));
  await session.chain;
  assert.equal(requests, 2);
  assert.equal(ws.sent[0].length, 16); assert.equal(ws.sent[1].length, 14);
  assert.deepEqual(ws.sent[0].slice(0, 4), new Uint8Array([0, 0, 0, 12]));
  session.stop();
});
test('text frames, queue overflow and idle handshakes are closed', async () => {
  for (const data of ['text', new Uint8Array(1024 * 1024 + 1)]) {
    const ws = new MockWebSocket(); const s = new TunnelSession(ws, config, () => {});
    s.start(new Uint8Array()); ws.message(data); assert.equal(s.stopped, true);
  }
  const ws = new MockWebSocket(); const s = new TunnelSession(ws, { ...config, timeoutMs: 10 }, () => {});
  s.start(new Uint8Array()); await delay(20); assert.equal(ws.code, 1008);
});
test('PROXYIP routes to the relay while preserving client payload', async () => {
  const ws = new MockWebSocket(); const socket = mockSocket(); let connected;
  const session = new TunnelSession(ws, { ...config, relay: { hostname: 'relay.example', port: 8443 } }, target => { connected = target; return socket; });
  session.start(requestBytes()); await session.chain;
  assert.deepEqual(connected, { hostname: 'relay.example', port: 8443 });
  assert.deepEqual(socket.writes, [new Uint8Array([7, 8])]); session.stop();
});

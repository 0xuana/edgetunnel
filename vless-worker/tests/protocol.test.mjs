import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, uuidBytes, joinBytes, DnsFrames, decodeEarlyData, parseSocks } from '../src/protocol.mjs';

export const UUID = '00112233-4455-4677-8899-aabbccddeeff';
export const identity = uuidBytes(UUID);
export function requestBytes({ command = 1, port = 443, type = 2, address = new TextEncoder().encode('example.com'), payload = new Uint8Array([7, 8]), options = new Uint8Array() } = {}) {
  return joinBytes(new Uint8Array([0]), identity, new Uint8Array([options.length]), options,
    new Uint8Array([command, port >> 8, port & 255, type]), type === 2 ? new Uint8Array([address.length]) : new Uint8Array(), address, payload);
}

test('handshake supports every byte boundary and optional fields', () => {
  const packet = requestBytes({ options: new Uint8Array([1, 2, 3]) });
  for (let i = 0; i < packet.length - 2; i++) assert.equal(parseRequest(packet.slice(0, i), identity), null);
  const parsed = parseRequest(packet, identity);
  assert.equal(parsed.hostname, 'example.com');
  assert.equal(parsed.port, 443);
  assert.deepEqual(parsed.payload, new Uint8Array([7, 8]));
});
test('IPv4 and IPv6 are parsed without consuming payload', () => {
  assert.equal(parseRequest(requestBytes({ type: 1, address: new Uint8Array([8, 8, 4, 4]) }), identity).hostname, '8.8.4.4');
  const ip6 = new Uint8Array(16); ip6[0] = 0x20; ip6[1] = 1; ip6[15] = 1;
  assert.equal(parseRequest(requestBytes({ type: 3, address: ip6 }), identity).hostname, '2001:0:0:0:0:0:0:1');
});
test('wrong UUID, version, command, port and address are rejected', () => {
  const packet = requestBytes(); packet[1] ^= 1;
  assert.throws(() => parseRequest(packet, identity), /identity/);
  const version = requestBytes(); version[0] = 1;
  assert.throws(() => parseRequest(version, identity), /version/);
  assert.throws(() => parseRequest(requestBytes({ command: 3 }), identity), /command/);
  assert.throws(() => parseRequest(requestBytes({ port: 0 }), identity), /port/);
  assert.throws(() => parseRequest(requestBytes({ command: 2, port: 443 }), identity), /DNS/);
  assert.throws(() => parseRequest(requestBytes({ type: 9 }), identity), /address/);
  assert.throws(() => parseRequest(requestBytes({ address: new Uint8Array() }), identity), /Empty/);
});
test('DNS framing preserves split lengths, split bodies and multiple messages', () => {
  const frame = joinBytes(new Uint8Array([0, 12]), new Uint8Array(12));
  const parser = new DnsFrames();
  assert.deepEqual(parser.push(frame.slice(0, 1)), []);
  assert.deepEqual(parser.push(frame.slice(1, 8)), []);
  assert.equal(parser.push(joinBytes(frame.slice(8), frame)).length, 2);
  assert.equal(parser.pending.length, 0);
  assert.throws(() => parser.push(new Uint8Array([0, 0])), /length/);
});
test('early data validates URL-safe base64 and size', () => {
  assert.deepEqual(decodeEarlyData('AP_-'), new Uint8Array([0, 255, 254]));
  assert.throws(() => decodeEarlyData('x'), /Invalid/);
  assert.throws(() => decodeEarlyData('ab,cd'), /Invalid/);
  assert.throws(() => decodeEarlyData('a'.repeat(12000)), /excessive/);
});
test('SOCKS5 config accepts IPv6 and URL-encoded credentials', () => {
  const proxy = parseSocks('socks5://a%40b:p%3Ass@[2001:db8::1]:1081');
  assert.equal(proxy.hostname, '2001:db8::1');
  assert.equal(proxy.port, 1081);
  assert.equal(new TextDecoder().decode(proxy.username), 'a@b');
  assert.equal(new TextDecoder().decode(proxy.password), 'p:ss');
  assert.equal(parseSocks('example.com').port, 1080);
  assert.throws(() => parseSocks('http://example.com'), /SOCKS5/);
  assert.throws(() => parseSocks('socks5://user@example.com'), /credentials/);
  assert.throws(() => parseSocks('socks5://example.com:0'), /port/);
});

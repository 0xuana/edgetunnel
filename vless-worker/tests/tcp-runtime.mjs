import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { UUID, requestBytes } from './fixtures.mjs';

const connections = new Set();
const visited = [];
const errors = [];
const server = net.createServer(socket => {
  connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('error', error => errors.push(error));
  let pending = Buffer.alloc(0); let stage = 0;
  socket.on('data', data => {
    pending = Buffer.concat([pending, data]);
    try {
      while (true) {
        if (stage === 0) {
          if (pending.length < 3) return;
          assert.deepEqual([...pending.subarray(0, 3)], [5, 1, 2]); pending = pending.subarray(3);
          socket.write(Buffer.from([5])); socket.write(Buffer.from([2])); stage = 1;
        } else if (stage === 1) {
          if (pending.length < 2) return;
          const userLength = pending[1];
          if (pending.length < userLength + 3) return;
          const passwordLength = pending[userLength + 2];
          const size = userLength + passwordLength + 3;
          if (pending.length < size) return;
          assert.equal(pending.subarray(2, userLength + 2).toString(), 'test-user');
          assert.equal(pending.subarray(userLength + 3, size).toString(), 'test-password');
          pending = pending.subarray(size); socket.write(Buffer.from([1, 0])); stage = 2;
        } else if (stage === 2) {
          if (pending.length < 5) return;
          assert.equal(pending[3], 3);
          const length = pending[4]; const size = 7 + length;
          if (pending.length < size) return;
          visited.push({ hostname: pending.subarray(5, 5 + length).toString(), port: pending.readUInt16BE(5 + length) });
          pending = pending.subarray(size);
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80])); stage = 3;
        } else {
          if (pending.length) socket.write(pending); pending = Buffer.alloc(0); return;
        }
      }
    } catch (error) { errors.push(error); socket.destroy(); }
  });
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const proxyPort = server.address().port;
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'worker.js', compatibilityDate: '2026-10-12', bindings: { UUID, SOCKS5: `socks5://test-user:test-password@127.0.0.1:${proxyPort}`, PROXYIP: 'unused-relay.invalid:1' } }));
try {
  const response = await mf.dispatchFetch('https://entry.example/tunnel', { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const client = response.webSocket; client.accept();
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Runtime SOCKS5 echo timed out')), 5000);
    client.addEventListener('message', event => { clearTimeout(timer); resolve(new Uint8Array(event.data)); }, { once: true });
    client.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Tunnel closed before echo')); }, { once: true });
  });
  const packet = requestBytes({ payload: new TextEncoder().encode('runtime-echo') });
  client.send(packet.slice(0, 9)); client.send(packet.slice(9));
  assert.deepEqual(await reply, new Uint8Array([0, 0, ...new TextEncoder().encode('runtime-echo')]));
  assert.deepEqual(visited, [{ hostname: 'example.com', port: 443 }]);
  assert.deepEqual(errors, []); client.close();
  console.log('Workers runtime: real TCP socket, authenticated SOCKS5, split VLESS handshake and bidirectional echo passed');
} finally {
  await mf.dispose(); for (const socket of connections) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}

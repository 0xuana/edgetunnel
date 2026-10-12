import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { UUID, requestBytes } from './fixtures.mjs';

const inline = Boolean(process.env.INLINE_WORKER);
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: inline ? resolve('../源码.js') : 'worker.js', ...(inline ? { modulesRoot: resolve('..'), rootPath: resolve('..') } : {}), compatibilityDate: '2026-10-12', bindings: { UUID, ADMIN: 'test-admin' }, kvNamespaces: ['SETTINGS'] }));
try {
  const request = (path, options) => mf.dispatchFetch(`https://entry.example${path}`, options);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/sub')).status, 401);
  const raw = await request(`/sub?token=${UUID}&format=raw`);
  assert.equal(raw.status, 200); assert.ok((await raw.text()).startsWith(`vless://${UUID}@entry.example:443?`));
  const base64 = await request(`/sub?token=${UUID}`);
  assert.ok(atob(await base64.text()).startsWith('vless://'));
  const clash = await request('/sub?format=clash', { headers: { Authorization: `Bearer ${UUID}` } });
  assert.equal((await clash.json()).proxies.length, 1);
  assert.equal((await request('/sub', { method: 'POST' })).status, 405);
  assert.equal((await request('/admin')).status, 200);
  assert.equal((await request('/admin/api')).status, 401);
  const authorization = { Authorization: 'Bearer test-admin', 'Content-Type': 'application/json' };
  const save = await request('/admin/api', { method: 'PUT', headers: authorization, body: JSON.stringify({ addresses: '104.16.1.1:8443#Custom' }) });
  assert.equal(save.status, 200);
  assert.equal((await (await request('/admin/api', { headers: authorization })).json()).addresses, '104.16.1.1:8443#Custom');
  assert.ok((await (await request(`/sub?token=${UUID}&format=raw`)).text()).includes('@104.16.1.1:8443?'));
  assert.equal((await request('/admin/api', { method: 'DELETE', headers: authorization })).status, 200);
  assert.equal((await request('/tunnel', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'bad,header' } })).status, 400);
  const upgraded = await request('/tunnel', { headers: { Upgrade: 'websocket' } });
  assert.equal(upgraded.status, 101);
  const client = upgraded.webSocket;
  client.accept();
  const closed = new Promise(resolve => client.addEventListener('close', resolve, { once: true }));
  const packet = requestBytes(); packet[1] ^= 1;
  client.send(packet);
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Unauthorized WebSocket did not close')), 3000).unref())]);
  console.log(`${process.env.INLINE_WORKER ? 'Import-free' : 'Module'} Workers runtime: HTTP routing, subscriptions, KV administration and WebSocket authentication passed`);
} finally { await mf.dispose(); }

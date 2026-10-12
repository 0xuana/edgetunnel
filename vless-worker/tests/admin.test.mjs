import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAsset, adminApi, preferredSettings } from '../src/admin.mjs';
import { settings } from '../src/settings.mjs';
import { UUID } from './fixtures.mjs';

const origin = new URL('https://entry.example');
const token = 'admin-credential-for-tests';
function context(withKv = true) {
  const entries = new Map();
  const env = { UUID, ADMIN: token, ADDRESSES: 'entry.example#Default' };
  if (withKv) env.SETTINGS = { async get(key) { return entries.get(key) ?? null; }, async put(key, value) { entries.set(key, value); }, async delete(key) { entries.delete(key); } };
  const config = settings(env, origin);
  const call = (method, data, authorized = true) => adminApi(new Request(new URL('/admin/api', origin), {
    method, headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env, config, origin);
  return { env, config, call, entries };
}
test('admin authenticates before storage writes or subscription-token disclosure', async () => {
  const { call, entries } = context();
  const response = await call('PUT', { addresses: '104.16.1.1' }, false);
  assert.equal(response.status, 401); assert.equal(entries.size, 0);
  assert.ok(!(await response.text()).includes(UUID));
});
test('preferred addresses persist, update subscriptions and reset to env', async () => {
  const { call, env } = context();
  const input = '104.16.1.1:8443#香港\n[2606:4700::1]:443#IPv6';
  const saved = await call('PUT', { addresses: input });
  assert.equal(saved.status, 200); assert.equal(saved.headers.get('Cache-Control'), 'no-store');
  assert.equal((await saved.json()).addresses, input);
  assert.equal((await preferredSettings(env, origin)).nodes[0].server, '104.16.1.1');
  assert.equal((await (await call('GET')).json()).addresses, input);
  assert.equal((await call('DELETE')).status, 200);
  assert.equal((await preferredSettings(env, origin)).nodes[0].server, 'entry.example');
});
test('invalid, oversized and empty lists leave persisted values unchanged', async () => {
  const { call, entries } = context();
  for (const addresses of ['', 'https://bad.example', 'a\n'.repeat(65), 'x'.repeat(17000)]) {
    assert.equal((await call('PUT', { addresses })).status, 400); assert.equal(entries.size, 0);
  }
});
test('no-KV deployments support subscriptions and report persistence unavailable', async () => {
  const { call, env } = context(false);
  assert.equal((await (await call('GET')).json()).persistent, false);
  assert.equal((await call('PUT', { addresses: 'example.com' })).status, 409);
  assert.equal((await preferredSettings(env, origin)).nodes[0].server, 'entry.example');
});
test('admin assets have a restrictive CSP and executable script syntax', async () => {
  const response = adminAsset('/admin');
  assert.ok(response.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
  assert.ok((await response.text()).includes('优选入口列表'));
  const script = await adminAsset('/admin/app.js').text();
  assert.doesNotThrow(() => new Function(script));
  assert.ok(!script.includes('localStorage')); assert.ok(!script.includes('innerHTML'));
});

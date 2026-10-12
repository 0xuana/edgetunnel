import test from 'node:test';
import assert from 'node:assert/strict';
import { settings, sameToken } from '../src/settings.mjs';
import { subscription } from '../src/subscription.mjs';
import { UUID } from './fixtures.mjs';

const origin = new URL('https://entry.example');
test('subscriptions encode custom addresses while preserving TLS host and path', async () => {
  const config = settings({ UUID, WS_PATH: '/my/tunnel', ADDRESSES: '104.16.1.1:8443#香港,[2606:4700::1]:443#IPv6', HOST: 'my.example' }, origin);
  const raw = await subscription(config, 'raw').text();
  const lines = raw.split('\n');
  assert.equal(lines.length, 2);
  const link = new URL(lines[0]);
  assert.equal(link.hostname, '104.16.1.1'); assert.equal(link.port, '8443');
  assert.equal(link.searchParams.get('sni'), 'my.example');
  assert.equal(link.searchParams.get('host'), 'my.example');
  assert.equal(link.searchParams.get('path'), '/my/tunnel');
  assert.equal(link.searchParams.get('security'), 'tls');
  assert.ok(decodeURIComponent(link.hash).includes('香港'));
  assert.equal(atob(await subscription(config, 'base64').text()), raw);
  const yaml = await subscription(config, 'clash').json();
  assert.equal(yaml.proxies[1].server, '2606:4700::1');
  assert.equal(yaml.proxies[0]['ws-opts'].headers.Host, 'my.example');
  assert.equal(yaml.proxies[0]['skip-cert-verify'], false);
});
test('settings reject invalid config without sharing request state', () => {
  assert.throws(() => settings({}, origin), /UUID/);
  for (const changes of [{ HOST: 'https://example.com' }, { WS_PATH: '/sub' }, { TIMEOUT_MS: 0 }, { SUB_TOKEN: 'short' }, { ADDRESSES: 'x:0' }, { DOH_URL: 'http://resolver.example' }]) {
    assert.throws(() => settings({ UUID, ...changes }, origin));
  }
  const first = settings({ UUID, SOCKS5: 'proxy.example' }, origin);
  const second = settings({ UUID }, new URL('https://other.example'));
  assert.equal(first.proxy.hostname, 'proxy.example'); assert.equal(second.proxy, null);
  assert.equal(second.host, 'other.example');
  assert.equal(sameToken(UUID, UUID), true); assert.equal(sameToken('invalid', UUID), false);
});
test('subscription rejects unknown formats and disables caching', () => {
  const response = subscription(settings({ UUID }, origin), 'unknown');
  assert.equal(response.status, 400); assert.equal(response.headers.get('Cache-Control'), 'no-store');
});
test('PROXYIP distinguishes inherited ports and explicit ports', () => {
  assert.deepEqual(settings({ UUID, PROXYIP: 'relay.example' }, origin).relay, { hostname: 'relay.example', port: null });
  assert.deepEqual(settings({ UUID, PROXYIP: '[2001:db8::1]:443' }, origin).relay, { hostname: '2001:db8::1', port: 443 });
  assert.throws(() => settings({ UUID, PROXYIP: 'relay.example:0' }, origin), /PROXYIP/);
  assert.throws(() => settings({ UUID, PROXYIP: 'https://relay.example' }, origin), /PROXYIP/);
});

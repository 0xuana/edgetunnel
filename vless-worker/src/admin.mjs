import { settings, sameToken } from './settings.mjs';

const key = 'preferred-addresses-v1';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VLESS 订阅管理</title>
<style>body{font:16px system-ui;margin:0;background:#f5f7fb;color:#172033}main{max-width:760px;margin:48px auto;padding:28px;background:white;border-radius:16px;box-shadow:0 8px 32px #17203312}h1{font-size:26px}label{display:block;margin:18px 0 8px}input,textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c3d2;border-radius:8px;font:inherit}textarea{font-family:monospace;min-height:240px}button{padding:11px 18px;margin:12px 8px 0 0;border:0;border-radius:8px;background:#244ed8;color:white;cursor:pointer}button:disabled{opacity:.5;cursor:wait}p{line-height:1.6}a{overflow-wrap:anywhere}#status{white-space:pre-wrap;min-height:24px}small{color:#526075}[hidden]{display:none!important}@media(max-width:800px){main{margin:16px;padding:20px}}</style>
<script src="/admin/app.js" defer></script></head><body><main>
<h1>VLESS 自定义优选订阅</h1><p>为客户端选择连接入口，TLS 和 WebSocket 主机仍使用你的 Worker 域名。</p>
<form id="login"><label for="password">管理密码</label><input id="password" type="password" autocomplete="current-password" required><button>登录</button></form>
<section id="editor" hidden><p id="storage"></p><label for="addresses">优选入口列表</label><textarea id="addresses" spellcheck="false" placeholder="104.16.1.1:443#香港&#10;edge.example.com:8443#备用&#10;[2606:4700::1]:443#IPv6"></textarea>
<small>每行一个 IP 或域名，可附 :端口 和 #备注。保存后更新客户端订阅即可生效；KV 更新可能需要短暂同步。</small>
<div><button id="save" type="button">保存列表</button><button id="reset" type="button">恢复环境变量列表</button><button id="logout" type="button">退出</button></div>
<h2>订阅地址</h2><p><a id="base64">Base64 订阅</a></p><p><a id="raw">明文 VLESS 链接</a></p><p><a id="clash">Clash / Mihomo 订阅</a></p>
<p>出口代理通过 Worker 的 SOCKS5 或 PROXYIP 配置，与本页的优选入口不同。</p></section>
<p id="status" role="status" aria-live="polite"></p></main></body></html>`;

const script = `const $ = id => document.getElementById(id);
let credential = '';
let busy = false;
async function api(method = 'GET', body) {
  const response = await fetch('/admin/api', { method, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function render(result) {
  $('addresses').value = result.addresses;
  $('storage').textContent = result.persistent ? '已连接存储，可以保存优选列表。' : '当前使用环境变量 ADDRESSES。保存列表需要绑定名称为 SETTINGS 的 KV 命名空间。';
  $('save').disabled = !result.persistent;
  $('reset').disabled = !result.persistent;
  for (const format of ['base64', 'raw', 'clash']) {
    const link = $(format); const url = new URL(result.subscriptionUrl);
    url.searchParams.set('format', format); link.href = url.href;
  }
  $('login').hidden = true; $('editor').hidden = false;
}
async function run(action) {
  if (busy) return; busy = true; $('status').textContent = '处理中…';
  try { await action(); } catch (error) { $('status').textContent = error.message; }
  finally { busy = false; }
}
$('login').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  credential = $('password').value; render(await api()); $('password').value = ''; $('status').textContent = '已登录';
}); });
$('save').addEventListener('click', () => run(async () => { render(await api('PUT', { addresses: $('addresses').value })); $('status').textContent = '已保存。请更新客户端订阅。'; }));
$('reset').addEventListener('click', () => run(async () => { render(await api('DELETE')); $('status').textContent = '已恢复环境变量列表。'; }));
$('logout').addEventListener('click', () => { if (busy) return; credential = ''; $('addresses').value = ''; $('password').value = ''; for (const id of ['base64', 'raw', 'clash']) $(id).removeAttribute('href'); $('editor').hidden = true; $('login').hidden = false; $('status').textContent = ''; });`;

export function adminAsset(path) {
  if (path === '/admin' || path === '/admin/') return new Response(page, { headers: { ...headers,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  } });
  if (path === '/admin/app.js') return new Response(script, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
  return null;
}

function store(env) {
  return env.SETTINGS && ['get', 'put', 'delete'].every(method => typeof env.SETTINGS[method] === 'function') ? env.SETTINGS : null;
}

export async function preferredSettings(env, url) {
  const saved = await store(env)?.get(key);
  return settings(saved === null || saved === undefined ? env : { ...env, ADDRESSES: saved }, url);
}

async function limitedBody(request) {
  if (!request.body) throw new Error('Missing request body');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) throw new Error('List is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

export async function adminApi(request, env, config, url) {
  const json = (body, status = 200) => Response.json(body, { status, headers });
  const token = request.headers.get('Authorization') || '';
  const expected = String(env.ADMIN || config.token);
  if (!token.startsWith('Bearer ') || !sameToken(token.slice(7), expected)) return json({ error: 'Unauthorized' }, 401);
  const kv = store(env);
  try {
    let addresses;
    if (request.method === 'GET') addresses = await kv?.get(key) ?? String(env.ADDRESSES || config.host);
    else if (request.method === 'PUT') {
      if (!kv) return json({ error: '请绑定 SETTINGS KV 后保存' }, 409);
      if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return json({ error: 'JSON body required' }, 415);
      const input = JSON.parse(await limitedBody(request));
      if (typeof input.addresses !== 'string' || !input.addresses.trim()) return json({ error: '请输入至少一个入口地址' }, 400);
      addresses = input.addresses.trim();
      settings({ ...env, ADDRESSES: addresses }, url);
      await kv.put(key, addresses);
    } else if (request.method === 'DELETE') {
      if (!kv) return json({ error: '请绑定 SETTINGS KV 后重置' }, 409);
      await kv.delete(key); addresses = String(env.ADDRESSES || config.host);
    } else return json({ error: 'Method not allowed' }, 405);
    const subscriptionUrl = new URL('/sub', url); subscriptionUrl.searchParams.set('token', config.token);
    return json({ addresses, persistent: Boolean(kv), subscriptionUrl: subscriptionUrl.href });
  } catch (error) {
    if (error instanceof SyntaxError || /address|endpoint|ADDRESSES|List is too large|Missing request body|node name/.test(error.message)) {
      return json({ error: '列表格式无效，请使用 IP或域名:端口#备注，最多64行、16KB' }, 400);
    }
    console.error('Preferred address storage failed:', error.name);
    return json({ error: '无法读取或保存列表，请检查 KV 绑定' }, 503);
  }
}

import { uuidBytes, parseSocks } from './protocol.mjs';

function hostname(value) {
  const input = String(value).trim();
  if (!input || /[\s/@?#\\]/.test(input)) throw new Error('HOST must be a hostname without a scheme or path');
  let url;
  try { url = new URL(`https://${input}`); } catch { throw new Error('Invalid hostname'); }
  if (url.port) throw new Error('HOST must not include a port');
  return url.hostname;
}

export function settings(env, requestUrl) {
  const uuid = String(env.UUID || '').trim().toLowerCase();
  const identity = uuidBytes(uuid);
  const host = hostname(env.HOST || requestUrl.hostname);
  const token = String(env.SUB_TOKEN || uuid);
  if (token.length < 16 || token.length > 256 || /[\r\n]/.test(token)) throw new Error('SUB_TOKEN must contain 16–256 characters');
  const path = String(env.WS_PATH || '/tunnel');
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.length > 200 || ['/', '/sub', '/health'].includes(path)) {
    throw new Error('WS_PATH must be an absolute path distinct from HTTP endpoints');
  }
  const proxy = parseSocks(String(env.SOCKS5 || '').trim());
  let doh;
  try { doh = new URL(env.DOH_URL || 'https://cloudflare-dns.com/dns-query'); }
  catch { throw new Error('Invalid DOH_URL'); }
  if (doh.protocol !== 'https:' || doh.username || doh.password || doh.hash) throw new Error('DOH_URL must be an HTTPS URL without credentials');
  const timeoutMs = Number(env.TIMEOUT_MS ?? 10000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw new Error('TIMEOUT_MS must be between 1000 and 30000');
  const rawAddresses = String(env.ADDRESSES || host).split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  if (!rawAddresses.length || rawAddresses.length > 64) throw new Error('ADDRESSES must contain 1–64 endpoints');
  const nodes = rawAddresses.map((item, index) => {
    const hash = item.indexOf('#');
    const address = hash === -1 ? item : item.slice(0, hash);
    const name = hash === -1 ? `VLESS ${index + 1}` : item.slice(hash + 1).trim();
    if (!address || /[\s/@?\\]/.test(address)) throw new Error('Invalid ADDRESSES endpoint');
    let endpoint;
    try { endpoint = new URL(`https://${address}`); } catch { throw new Error('Invalid ADDRESSES endpoint'); }
    const port = Number(endpoint.port || 443);
    if (!port || port > 65535) throw new Error('Invalid ADDRESSES port');
    if (!name || name.length > 100) throw new Error('Invalid node name');
    return { server: endpoint.hostname, port, name: `${name} (${index + 1})` };
  });
  return { uuid, identity, host, token, path, proxy, doh: doh.href, timeoutMs, nodes };
}

export function sameToken(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < right.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

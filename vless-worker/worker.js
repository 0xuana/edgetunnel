// Single-file Worker. cloudflare:sockets is built into Cloudflare; no additional files are required.

// src/worker.mjs
import { connect } from "cloudflare:sockets";

// src/protocol.mjs
var utf8 = new TextDecoder("utf-8", { fatal: true });
var encoder = new TextEncoder();
function joinBytes(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function uuidBytes(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("UUID must be a canonical UUID");
  }
  return Uint8Array.from(value.replaceAll("-", "").match(/../g), (byte) => parseInt(byte, 16));
}
function parseRequest(data, identity) {
  if (!data.length) return null;
  if (data[0] !== 0) throw new Error("Unsupported VLESS version");
  if (data.length < 18) return null;
  let difference = 0;
  for (let i = 0; i < 16; i++) difference |= data[i + 1] ^ identity[i];
  if (difference) throw new Error("Invalid VLESS identity");
  const commandOffset = 18 + data[17];
  if (data.length < commandOffset + 4) return null;
  const command = data[commandOffset];
  if (command !== 1 && command !== 2) throw new Error("Unsupported VLESS command");
  const port = data[commandOffset + 1] * 256 + data[commandOffset + 2];
  if (!port) throw new Error("Invalid destination port");
  if (command === 2 && port !== 53) throw new Error("UDP is supported only for DNS");
  const type = data[commandOffset + 3];
  let start = commandOffset + 4;
  let length;
  if (type === 1) length = 4;
  else if (type === 3) length = 16;
  else if (type === 2) {
    if (data.length <= start) return null;
    length = data[start++];
    if (!length) throw new Error("Empty destination hostname");
  } else throw new Error("Unsupported destination address type");
  if (data.length < start + length) return null;
  const address = data.slice(start, start + length);
  let hostname2;
  if (type === 1) hostname2 = [...address].join(".");
  else if (type === 3) {
    hostname2 = Array.from({ length: 8 }, (_, i) => (address[i * 2] * 256 + address[i * 2 + 1]).toString(16)).join(":");
  } else {
    hostname2 = utf8.decode(address);
    if (!/^[a-z0-9._-]+$/i.test(hostname2)) throw new Error("Invalid destination hostname");
  }
  return { command, port, type, address, hostname: hostname2, payload: data.slice(start + length) };
}
function decodeEarlyData(value) {
  if (!value) return new Uint8Array();
  if (value.length > 10924 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid or excessive early data");
  }
  const decoded = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
  if (decoded.length > 8192) throw new Error("Excessive early data");
  return decoded;
}
var DnsFrames = class {
  pending = new Uint8Array();
  push(chunk) {
    const bytes = joinBytes(this.pending, chunk);
    const messages = [];
    let offset = 0;
    while (bytes.length - offset >= 2) {
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 12) throw new Error("Invalid DNS packet length");
      if (bytes.length - offset < length + 2) break;
      messages.push(bytes.slice(offset + 2, offset + length + 2));
      offset += length + 2;
    }
    this.pending = bytes.slice(offset);
    return messages;
  }
};
function parseSocks(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value.includes("://") ? value : `socks5://${value}`);
  } catch {
    throw new Error("Invalid SOCKS5 URL");
  }
  if (url.protocol !== "socks5:" || !url.hostname || url.pathname && url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SOCKS5 must be socks5://[user:password@]host:port");
  }
  let username, password;
  try {
    username = encoder.encode(decodeURIComponent(url.username));
    password = encoder.encode(decodeURIComponent(url.password));
  } catch {
    throw new Error("Invalid SOCKS5 credential encoding");
  }
  if (Boolean(username.length) !== Boolean(password.length) || username.length > 255 || password.length > 255) {
    throw new Error("SOCKS5 credentials must contain 1\u2013255 UTF-8 bytes each");
  }
  const port = Number(url.port || 1080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid SOCKS5 port");
  return { hostname: url.hostname.replace(/^\[|\]$/g, ""), port, username, password };
}

// src/settings.mjs
function hostname(value) {
  const input = String(value).trim();
  if (!input || /[\s/@?#\\]/.test(input)) throw new Error("HOST must be a hostname without a scheme or path");
  let url;
  try {
    url = new URL(`https://${input}`);
  } catch {
    throw new Error("Invalid hostname");
  }
  if (url.port) throw new Error("HOST must not include a port");
  return url.hostname;
}
function settings(env, requestUrl) {
  const uuid = String(env.UUID || "").trim().toLowerCase();
  const identity = uuidBytes(uuid);
  const host = hostname(env.HOST || requestUrl.hostname);
  const token = String(env.SUB_TOKEN || uuid);
  if (token.length < 16 || token.length > 256 || /[\r\n]/.test(token)) throw new Error("SUB_TOKEN must contain 16\u2013256 characters");
  const path = String(env.WS_PATH || "/tunnel");
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.length > 200 || ["/", "/sub", "/health"].includes(path)) {
    throw new Error("WS_PATH must be an absolute path distinct from HTTP endpoints");
  }
  const proxy = parseSocks(String(env.SOCKS5 || "").trim());
  let relay = null;
  if (env.PROXYIP) {
    const input = String(env.PROXYIP).trim();
    if (!input || /[\s/@?#\\]/.test(input)) throw new Error("PROXYIP must be host[:port]");
    let endpoint;
    try {
      endpoint = new URL(`https://${input}`);
    } catch {
      throw new Error("Invalid PROXYIP");
    }
    const explicitPort = input.startsWith("[") ? input.slice(input.indexOf("]") + 1).startsWith(":") : input.includes(":");
    const port = explicitPort ? Number(input.slice(input.lastIndexOf(":") + 1)) : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid PROXYIP port");
    relay = { hostname: endpoint.hostname.replace(/^\[|\]$/g, ""), port };
  }
  let doh;
  try {
    doh = new URL(env.DOH_URL || "https://cloudflare-dns.com/dns-query");
  } catch {
    throw new Error("Invalid DOH_URL");
  }
  if (doh.protocol !== "https:" || doh.username || doh.password || doh.hash) throw new Error("DOH_URL must be an HTTPS URL without credentials");
  const timeoutMs = Number(env.TIMEOUT_MS ?? 1e4);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1e3 || timeoutMs > 3e4) throw new Error("TIMEOUT_MS must be between 1000 and 30000");
  const rawAddresses = String(env.ADDRESSES || host).split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
  if (!rawAddresses.length || rawAddresses.length > 64) throw new Error("ADDRESSES must contain 1\u201364 endpoints");
  const nodes = rawAddresses.map((item, index) => {
    const hash = item.indexOf("#");
    const address = hash === -1 ? item : item.slice(0, hash);
    const name = hash === -1 ? `VLESS ${index + 1}` : item.slice(hash + 1).trim();
    if (!address || /[\s/@?\\]/.test(address)) throw new Error("Invalid ADDRESSES endpoint");
    let endpoint;
    try {
      endpoint = new URL(`https://${address}`);
    } catch {
      throw new Error("Invalid ADDRESSES endpoint");
    }
    const port = Number(endpoint.port || 443);
    if (!port || port > 65535) throw new Error("Invalid ADDRESSES port");
    if (!name || name.length > 100) throw new Error("Invalid node name");
    return { server: endpoint.hostname, port, name: `${name} (${index + 1})` };
  });
  return { uuid, identity, host, token, path, proxy, relay, doh: doh.href, timeoutMs, nodes };
}
function sameToken(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < right.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

// src/subscription.mjs
function links(config) {
  return config.nodes.map((node) => {
    const query = new URLSearchParams({ encryption: "none", security: "tls", sni: config.host.replace(/^\[|\]$/g, ""), fp: "chrome", type: "ws", host: config.host, path: config.path });
    return `vless://${config.uuid}@${node.server}:${node.port}?${query}#${encodeURIComponent(node.name)}`;
  }).join("\n");
}
function subscription(config, format) {
  const common = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (format === "clash") {
    const proxies = config.nodes.map((node) => ({
      name: node.name,
      type: "vless",
      server: node.server.replace(/^\[|\]$/g, ""),
      port: node.port,
      uuid: config.uuid,
      network: "ws",
      tls: true,
      udp: true,
      servername: config.host.replace(/^\[|\]$/g, ""),
      "client-fingerprint": "chrome",
      "skip-cert-verify": false,
      "ws-opts": { path: config.path, headers: { Host: config.host } }
    }));
    const content = {
      "mixed-port": 7890,
      "allow-lan": false,
      mode: "rule",
      proxies,
      "proxy-groups": [{ name: "VLESS", type: "select", proxies: proxies.map((p) => p.name) }],
      rules: ["MATCH,VLESS"]
    };
    return new Response(JSON.stringify(content, null, 2), { headers: { ...common, "Content-Type": "application/yaml; charset=utf-8" } });
  }
  if (format !== "raw" && format !== "base64") return new Response("Unsupported format", { status: 400, headers: common });
  const text = links(config);
  const body = format === "raw" ? text : btoa(text);
  return new Response(body, { headers: { ...common, "Content-Type": "text/plain; charset=utf-8" } });
}

// src/transport.mjs
async function deadline(operation, milliseconds, onTimeout = () => {
}) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error("Operation timed out"));
        }, milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function closeSocket(socket) {
  try {
    Promise.resolve(socket?.close()).catch(() => {
    });
  } catch {
  }
}
async function openTcp(connect2, destination, proxy, timeoutMs = 1e4, onSocket = () => {
}) {
  const socket = connect2(proxy ? { hostname: proxy.hostname, port: proxy.port } : { hostname: destination.hostname, port: destination.port });
  socket.closed.catch(() => {
  });
  let reader, writer;
  try {
    onSocket(socket);
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    const state = { pending: new Uint8Array() };
    const exact = async (length) => {
      while (state.pending.length < length) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SOCKS5 closed during handshake");
        state.pending = joinBytes(state.pending, value);
        if (state.pending.length > 1024 * 1024) throw new Error("Excessive SOCKS5 reply");
      }
      const result = state.pending.slice(0, length);
      state.pending = state.pending.slice(length);
      return result;
    };
    await deadline((async () => {
      await socket.opened;
      if (!proxy) return;
      const authenticated = proxy.username.length > 0;
      await writer.write(new Uint8Array([5, 1, authenticated ? 2 : 0]));
      const method = await exact(2);
      if (method[0] !== 5 || method[1] !== (authenticated ? 2 : 0)) throw new Error("SOCKS5 authentication method rejected");
      if (authenticated) {
        await writer.write(joinBytes(new Uint8Array([1, proxy.username.length]), proxy.username, new Uint8Array([proxy.password.length]), proxy.password));
        const auth = await exact(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error("SOCKS5 credentials rejected");
      }
      const addressType = destination.type === 1 ? 1 : destination.type === 3 ? 4 : 3;
      await writer.write(joinBytes(
        new Uint8Array([5, 1, 0, addressType]),
        addressType === 3 ? new Uint8Array([destination.address.length]) : new Uint8Array(),
        destination.address,
        new Uint8Array([destination.port >> 8, destination.port & 255])
      ));
      const reply = await exact(4);
      if (reply[0] !== 5 || reply[2] !== 0 || reply[1] !== 0) throw new Error("SOCKS5 CONNECT rejected");
      let boundLength;
      if (reply[3] === 1) boundLength = 4;
      else if (reply[3] === 4) boundLength = 16;
      else if (reply[3] === 3) boundLength = (await exact(1))[0];
      else throw new Error("Invalid SOCKS5 reply address");
      await exact(boundLength + 2);
    })(), timeoutMs, () => closeSocket(socket));
    return { socket, reader, writer, prefix: state.pending };
  } catch (error) {
    closeSocket(socket);
    try {
      reader?.releaseLock();
    } catch {
    }
    try {
      writer?.releaseLock();
    } catch {
    }
    throw error;
  }
}
var TunnelSession = class {
  constructor(ws, config, connect2, fetcher = fetch) {
    this.ws = ws;
    this.config = config;
    this.connect = connect2;
    this.fetcher = fetcher;
    this.pending = new Uint8Array();
    this.frames = new DnsFrames();
    this.queuedBytes = 0;
    this.queuedMessages = 0;
    this.chain = Promise.resolve();
    this.stopped = false;
    this.headerSent = false;
    this.timer = setTimeout(() => this.stop(1008, "Handshake timed out"), config.timeoutMs);
  }
  start(earlyData) {
    this.ws.addEventListener("message", (event) => this.enqueue(event.data));
    this.ws.addEventListener("close", () => this.stop(1e3, "Client closed"));
    this.ws.addEventListener("error", () => this.stop(1011, "WebSocket error"));
    if (earlyData.length) this.enqueue(earlyData);
  }
  enqueue(data) {
    if (this.stopped) return;
    const size = data instanceof Blob ? data.size : data?.byteLength;
    if (typeof size !== "number") return this.stop(1003, "Binary messages required");
    if (size > 1024 * 1024 || this.queuedBytes + size > 4 * 1024 * 1024 || this.queuedMessages >= 256) {
      return this.stop(1009, "Input queue limit exceeded");
    }
    this.queuedBytes += size;
    this.queuedMessages++;
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      await this.consume(bytes);
    }).catch((error) => {
      if (!this.stopped) console.error("Tunnel session failed:", error.message);
      this.stop(1011, "Tunnel failed");
    }).finally(() => {
      this.queuedBytes -= size;
      this.queuedMessages--;
    });
  }
  async consume(bytes) {
    if (!this.destination) {
      this.pending = joinBytes(this.pending, bytes);
      const destination = parseRequest(this.pending, this.config.identity);
      if (!destination) {
        if (this.pending.length > 1024) throw new Error("Excessive handshake");
        return;
      }
      this.destination = destination;
      this.pending = new Uint8Array();
      clearTimeout(this.timer);
      bytes = destination.payload;
      if (destination.command === 1) {
        const target = !this.config.proxy && this.config.relay ? {
          ...destination,
          hostname: this.config.relay.hostname,
          port: this.config.relay.port ?? destination.port
        } : destination;
        this.upstream = await openTcp(this.connect, target, this.config.proxy, this.config.timeoutMs, (socket) => {
          this.socket = socket;
          if (this.stopped) {
            closeSocket(socket);
            throw new Error("Client already closed");
          }
        });
        if (this.stopped) return;
        this.receive().catch((error) => {
          if (!this.stopped) console.error("Upstream read failed:", error.name);
          this.stop(1011, "Upstream failed");
        });
      }
    }
    if (this.stopped || !bytes.length) return;
    if (this.destination.command === 1) {
      await deadline(this.upstream.writer.write(bytes), this.config.timeoutMs, () => this.stop(1011, "Upstream write timed out"));
    } else {
      for (const message of this.frames.push(bytes)) await this.queryDns(message);
    }
  }
  send(bytes) {
    if (this.stopped || this.ws.readyState !== 1 || !bytes.length) return;
    this.ws.send(this.headerSent ? bytes : joinBytes(new Uint8Array([0, 0]), bytes));
    this.headerSent = true;
  }
  async receive() {
    if (this.upstream.prefix.length) this.send(this.upstream.prefix);
    while (!this.stopped) {
      const { value, done } = await this.upstream.reader.read();
      if (done) {
        this.stop(1e3, "Upstream closed");
        return;
      }
      this.send(value);
    }
  }
  async queryDns(message) {
    const aborter = new AbortController();
    this.dnsAborter = aborter;
    try {
      await deadline((async () => {
        const response = await this.fetcher(this.config.doh, {
          method: "POST",
          headers: { "Content-Type": "application/dns-message", Accept: "application/dns-message" },
          body: message,
          signal: aborter.signal,
          redirect: "error"
        });
        if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/dns-message")) {
          await response.body?.cancel();
          throw new Error("DNS resolver rejected request");
        }
        if (!response.body) throw new Error("Empty DNS response");
        const reader = response.body.getReader();
        let answer = new Uint8Array();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (answer.length + value.length > 65535) throw new Error("Excessive DNS response");
            answer = joinBytes(answer, value);
          }
        } finally {
          await reader.cancel().catch(() => {
          });
          reader.releaseLock();
        }
        if (answer.length < 12) throw new Error("Invalid DNS response");
        this.send(joinBytes(new Uint8Array([answer.length >> 8, answer.length & 255]), answer));
      })(), this.config.timeoutMs, () => aborter.abort());
    } finally {
      this.dnsAborter = null;
    }
  }
  stop(code = 1e3, reason = "Closed") {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.dnsAborter?.abort();
    closeSocket(this.socket);
    if (this.upstream) {
      this.upstream.reader.cancel().catch(() => {
      });
      try {
        this.upstream.writer.releaseLock();
      } catch {
      }
    }
    try {
      if (this.ws.readyState === 1 || this.ws.readyState === 2) this.ws.close(code, reason);
    } catch {
    }
  }
};
function upgrade(request, config, connect2) {
  const earlyData = decodeEarlyData(request.headers.get("Sec-WebSocket-Protocol") || "");
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  new TunnelSession(server, config, connect2).start(earlyData);
  return new Response(null, { status: 101, webSocket: client });
}

// src/admin.mjs
var key = "preferred-addresses-v1";
var headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
var page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VLESS \u8BA2\u9605\u7BA1\u7406</title>
<style>body{font:16px system-ui;margin:0;background:#f5f7fb;color:#172033}main{max-width:760px;margin:48px auto;padding:28px;background:white;border-radius:16px;box-shadow:0 8px 32px #17203312}h1{font-size:26px}label{display:block;margin:18px 0 8px}input,textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c3d2;border-radius:8px;font:inherit}textarea{font-family:monospace;min-height:240px}button{padding:11px 18px;margin:12px 8px 0 0;border:0;border-radius:8px;background:#244ed8;color:white;cursor:pointer}button:disabled{opacity:.5;cursor:wait}p{line-height:1.6}a{overflow-wrap:anywhere}#status{white-space:pre-wrap;min-height:24px}small{color:#526075}[hidden]{display:none!important}@media(max-width:800px){main{margin:16px;padding:20px}}</style>
<script src="/admin/app.js" defer><\/script></head><body><main>
<h1>VLESS \u81EA\u5B9A\u4E49\u4F18\u9009\u8BA2\u9605</h1><p>\u4E3A\u5BA2\u6237\u7AEF\u9009\u62E9\u8FDE\u63A5\u5165\u53E3\uFF0CTLS \u548C WebSocket \u4E3B\u673A\u4ECD\u4F7F\u7528\u4F60\u7684 Worker \u57DF\u540D\u3002</p>
<form id="login"><label for="password">\u7BA1\u7406\u5BC6\u7801</label><input id="password" type="password" autocomplete="current-password" required><button>\u767B\u5F55</button></form>
<section id="editor" hidden><p id="storage"></p><label for="addresses">\u4F18\u9009\u5165\u53E3\u5217\u8868</label><textarea id="addresses" spellcheck="false" placeholder="104.16.1.1:443#\u9999\u6E2F&#10;edge.example.com:8443#\u5907\u7528&#10;[2606:4700::1]:443#IPv6"></textarea>
<small>\u6BCF\u884C\u4E00\u4E2A IP \u6216\u57DF\u540D\uFF0C\u53EF\u9644 :\u7AEF\u53E3 \u548C #\u5907\u6CE8\u3002\u4FDD\u5B58\u540E\u66F4\u65B0\u5BA2\u6237\u7AEF\u8BA2\u9605\u5373\u53EF\u751F\u6548\uFF1BKV \u66F4\u65B0\u53EF\u80FD\u9700\u8981\u77ED\u6682\u540C\u6B65\u3002</small>
<div><button id="save" type="button">\u4FDD\u5B58\u5217\u8868</button><button id="reset" type="button">\u6062\u590D\u73AF\u5883\u53D8\u91CF\u5217\u8868</button><button id="logout" type="button">\u9000\u51FA</button></div>
<h2>\u8BA2\u9605\u5730\u5740</h2><p><a id="base64">Base64 \u8BA2\u9605</a></p><p><a id="raw">\u660E\u6587 VLESS \u94FE\u63A5</a></p><p><a id="clash">Clash / Mihomo \u8BA2\u9605</a></p>
<p>\u51FA\u53E3\u4EE3\u7406\u901A\u8FC7 Worker \u7684 SOCKS5 \u6216 PROXYIP \u914D\u7F6E\uFF0C\u4E0E\u672C\u9875\u7684\u4F18\u9009\u5165\u53E3\u4E0D\u540C\u3002</p></section>
<p id="status" role="status" aria-live="polite"></p></main></body></html>`;
var script = `const $ = id => document.getElementById(id);
let credential = '';
let busy = false;
async function api(method = 'GET', body) {
  const response = await fetch('/admin/api', { method, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '\u8BF7\u6C42\u5931\u8D25');
  return result;
}
function render(result) {
  $('addresses').value = result.addresses;
  $('storage').textContent = result.persistent ? '\u5DF2\u8FDE\u63A5\u5B58\u50A8\uFF0C\u53EF\u4EE5\u4FDD\u5B58\u4F18\u9009\u5217\u8868\u3002' : '\u5F53\u524D\u4F7F\u7528\u73AF\u5883\u53D8\u91CF ADDRESSES\u3002\u4FDD\u5B58\u5217\u8868\u9700\u8981\u7ED1\u5B9A\u540D\u79F0\u4E3A SETTINGS \u7684 KV \u547D\u540D\u7A7A\u95F4\u3002';
  $('save').disabled = !result.persistent;
  $('reset').disabled = !result.persistent;
  for (const format of ['base64', 'raw', 'clash']) {
    const link = $(format); const url = new URL(result.subscriptionUrl);
    url.searchParams.set('format', format); link.href = url.href;
  }
  $('login').hidden = true; $('editor').hidden = false;
}
async function run(action) {
  if (busy) return; busy = true; $('status').textContent = '\u5904\u7406\u4E2D\u2026';
  try { await action(); } catch (error) { $('status').textContent = error.message; }
  finally { busy = false; }
}
$('login').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  credential = $('password').value; render(await api()); $('password').value = ''; $('status').textContent = '\u5DF2\u767B\u5F55';
}); });
$('save').addEventListener('click', () => run(async () => { render(await api('PUT', { addresses: $('addresses').value })); $('status').textContent = '\u5DF2\u4FDD\u5B58\u3002\u8BF7\u66F4\u65B0\u5BA2\u6237\u7AEF\u8BA2\u9605\u3002'; }));
$('reset').addEventListener('click', () => run(async () => { render(await api('DELETE')); $('status').textContent = '\u5DF2\u6062\u590D\u73AF\u5883\u53D8\u91CF\u5217\u8868\u3002'; }));
$('logout').addEventListener('click', () => { if (busy) return; credential = ''; $('addresses').value = ''; $('password').value = ''; for (const id of ['base64', 'raw', 'clash']) $(id).removeAttribute('href'); $('editor').hidden = true; $('login').hidden = false; $('status').textContent = ''; });`;
function adminAsset(path) {
  if (path === "/admin" || path === "/admin/") return new Response(page, { headers: {
    ...headers,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  } });
  if (path === "/admin/app.js") return new Response(script, { headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
  return null;
}
function store(env) {
  return env.SETTINGS && ["get", "put", "delete"].every((method) => typeof env.SETTINGS[method] === "function") ? env.SETTINGS : null;
}
async function preferredSettings(env, url) {
  const saved = await store(env)?.get(key);
  return settings(saved === null || saved === void 0 ? env : { ...env, ADDRESSES: saved }, url);
}
async function limitedBody(request) {
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) throw new Error("List is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}
async function adminApi(request, env, config, url) {
  const json = (body, status = 200) => Response.json(body, { status, headers });
  const token = request.headers.get("Authorization") || "";
  const expected = String(env.ADMIN || config.token);
  if (!token.startsWith("Bearer ") || !sameToken(token.slice(7), expected)) return json({ error: "Unauthorized" }, 401);
  const kv = store(env);
  try {
    let addresses;
    if (request.method === "GET") addresses = await kv?.get(key) ?? String(env.ADDRESSES || config.host);
    else if (request.method === "PUT") {
      if (!kv) return json({ error: "\u8BF7\u7ED1\u5B9A SETTINGS KV \u540E\u4FDD\u5B58" }, 409);
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json({ error: "JSON body required" }, 415);
      const input = JSON.parse(await limitedBody(request));
      if (typeof input.addresses !== "string" || !input.addresses.trim()) return json({ error: "\u8BF7\u8F93\u5165\u81F3\u5C11\u4E00\u4E2A\u5165\u53E3\u5730\u5740" }, 400);
      addresses = input.addresses.trim();
      settings({ ...env, ADDRESSES: addresses }, url);
      await kv.put(key, addresses);
    } else if (request.method === "DELETE") {
      if (!kv) return json({ error: "\u8BF7\u7ED1\u5B9A SETTINGS KV \u540E\u91CD\u7F6E" }, 409);
      await kv.delete(key);
      addresses = String(env.ADDRESSES || config.host);
    } else return json({ error: "Method not allowed" }, 405);
    const subscriptionUrl = new URL("/sub", url);
    subscriptionUrl.searchParams.set("token", config.token);
    return json({ addresses, persistent: Boolean(kv), subscriptionUrl: subscriptionUrl.href });
  } catch (error) {
    if (error instanceof SyntaxError || /address|endpoint|ADDRESSES|List is too large|Missing request body|node name/.test(error.message)) {
      return json({ error: "\u5217\u8868\u683C\u5F0F\u65E0\u6548\uFF0C\u8BF7\u4F7F\u7528 IP\u6216\u57DF\u540D:\u7AEF\u53E3#\u5907\u6CE8\uFF0C\u6700\u591A64\u884C\u300116KB" }, 400);
    }
    console.error("Preferred address storage failed:", error.name);
    return json({ error: "\u65E0\u6CD5\u8BFB\u53D6\u6216\u4FDD\u5B58\u5217\u8868\uFF0C\u8BF7\u68C0\u67E5 KV \u7ED1\u5B9A" }, 503);
  }
}

// src/worker.mjs
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wantsWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (!wantsWebSocket && (url.pathname === "/" || url.pathname === "/health") && request.method === "GET") {
      return new Response("VLESS Worker is running\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    if (!wantsWebSocket && request.method === "GET") {
      const asset = adminAsset(url.pathname);
      if (asset) return asset;
    }
    if (request.method !== "GET" && url.pathname !== "/admin/api") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
    let config;
    try {
      config = settings(env, url);
    } catch (error) {
      console.error("Worker configuration error:", error.message);
      return new Response("Worker configuration is incomplete or invalid", { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/admin/api" && !wantsWebSocket) return adminApi(request, env, config, url);
    if (wantsWebSocket) {
      if (url.pathname !== config.path) return new Response("Not found", { status: 404 });
      try {
        return upgrade(request, config, connect);
      } catch {
        return new Response("Invalid WebSocket handshake", { status: 400 });
      }
    }
    if (url.pathname === "/sub") {
      const authorization = request.headers.get("Authorization") || "";
      const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : url.searchParams.get("token") || "";
      if (!sameToken(provided, config.token)) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
      try {
        return subscription(await preferredSettings(env, url), url.searchParams.get("format") || "base64");
      } catch (error) {
        console.error("Subscription configuration failed:", error.name);
        return new Response("Subscription configuration unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }
    return new Response("Not found", { status: 404 });
  }
};
export {
  worker_default as default
};

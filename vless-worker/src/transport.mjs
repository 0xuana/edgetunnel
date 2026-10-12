import { joinBytes, parseRequest, decodeEarlyData, DnsFrames } from './protocol.mjs';

export async function deadline(operation, milliseconds, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new Error('Operation timed out')); }, milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

function closeSocket(socket) {
  try { Promise.resolve(socket?.close()).catch(() => {}); } catch {}
}

// The handshake reader stays locked: any bytes after CONNECT belong to the target.
export async function openTcp(connect, destination, proxy, timeoutMs = 10000, onSocket = () => {}) {
  const socket = connect(proxy ? { hostname: proxy.hostname, port: proxy.port } : { hostname: destination.hostname, port: destination.port });
  socket.closed.catch(() => {});
  let reader, writer;
  try {
    onSocket(socket);
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    const state = { pending: new Uint8Array() };
    const exact = async length => {
      while (state.pending.length < length) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SOCKS5 closed during handshake');
        state.pending = joinBytes(state.pending, value);
        if (state.pending.length > 1024 * 1024) throw new Error('Excessive SOCKS5 reply');
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
      if (method[0] !== 5 || method[1] !== (authenticated ? 2 : 0)) throw new Error('SOCKS5 authentication method rejected');
      if (authenticated) {
        await writer.write(joinBytes(new Uint8Array([1, proxy.username.length]), proxy.username, new Uint8Array([proxy.password.length]), proxy.password));
        const auth = await exact(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error('SOCKS5 credentials rejected');
      }
      const addressType = destination.type === 1 ? 1 : destination.type === 3 ? 4 : 3;
      await writer.write(joinBytes(new Uint8Array([5, 1, 0, addressType]),
        addressType === 3 ? new Uint8Array([destination.address.length]) : new Uint8Array(),
        destination.address, new Uint8Array([destination.port >> 8, destination.port & 255])));
      const reply = await exact(4);
      if (reply[0] !== 5 || reply[2] !== 0 || reply[1] !== 0) throw new Error('SOCKS5 CONNECT rejected');
      let boundLength;
      if (reply[3] === 1) boundLength = 4;
      else if (reply[3] === 4) boundLength = 16;
      else if (reply[3] === 3) boundLength = (await exact(1))[0];
      else throw new Error('Invalid SOCKS5 reply address');
      await exact(boundLength + 2);
    })(), timeoutMs, () => closeSocket(socket));
    return { socket, reader, writer, prefix: state.pending };
  } catch (error) {
    closeSocket(socket);
    try { reader?.releaseLock(); } catch {}
    try { writer?.releaseLock(); } catch {}
    throw error;
  }
}

export class TunnelSession {
  constructor(ws, config, connect, fetcher = fetch) {
    this.ws = ws;
    this.config = config;
    this.connect = connect;
    this.fetcher = fetcher;
    this.pending = new Uint8Array();
    this.frames = new DnsFrames();
    this.queuedBytes = 0;
    this.queuedMessages = 0;
    this.chain = Promise.resolve();
    this.stopped = false;
    this.headerSent = false;
    this.timer = setTimeout(() => this.stop(1008, 'Handshake timed out'), config.timeoutMs);
  }

  start(earlyData) {
    this.ws.addEventListener('message', event => this.enqueue(event.data));
    this.ws.addEventListener('close', () => this.stop(1000, 'Client closed'));
    this.ws.addEventListener('error', () => this.stop(1011, 'WebSocket error'));
    if (earlyData.length) this.enqueue(earlyData);
  }

  enqueue(data) {
    if (this.stopped) return;
    const size = data instanceof Blob ? data.size : data?.byteLength;
    if (typeof size !== 'number') return this.stop(1003, 'Binary messages required');
    if (size > 1024 * 1024 || this.queuedBytes + size > 4 * 1024 * 1024 || this.queuedMessages >= 256) {
      return this.stop(1009, 'Input queue limit exceeded');
    }
    this.queuedBytes += size;
    this.queuedMessages++;
    this.chain = this.chain.then(async () => {
      if (this.stopped) return;
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) :
        ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      await this.consume(bytes);
    }).catch(error => {
      if (!this.stopped) console.error('Tunnel session failed:', error.message);
      this.stop(1011, 'Tunnel failed');
    }).finally(() => { this.queuedBytes -= size; this.queuedMessages--; });
  }

  async consume(bytes) {
    if (!this.destination) {
      this.pending = joinBytes(this.pending, bytes);
      const destination = parseRequest(this.pending, this.config.identity);
      if (!destination) {
        if (this.pending.length > 1024) throw new Error('Excessive handshake');
        return;
      }
      this.destination = destination;
      this.pending = new Uint8Array();
      clearTimeout(this.timer);
      bytes = destination.payload;
      if (destination.command === 1) {
        this.upstream = await openTcp(this.connect, destination, this.config.proxy, this.config.timeoutMs, socket => {
          this.socket = socket;
          if (this.stopped) { closeSocket(socket); throw new Error('Client already closed'); }
        });
        if (this.stopped) return;
        this.receive().catch(error => {
          if (!this.stopped) console.error('Upstream read failed:', error.name);
          this.stop(1011, 'Upstream failed');
        });
      }
    }
    if (this.stopped || !bytes.length) return;
    if (this.destination.command === 1) {
      await deadline(this.upstream.writer.write(bytes), this.config.timeoutMs, () => this.stop(1011, 'Upstream write timed out'));
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
      if (done) { this.stop(1000, 'Upstream closed'); return; }
      this.send(value);
    }
  }

  async queryDns(message) {
    const aborter = new AbortController();
    this.dnsAborter = aborter;
    try {
      await deadline((async () => {
        const response = await this.fetcher(this.config.doh, {
          method: 'POST', headers: { 'Content-Type': 'application/dns-message', Accept: 'application/dns-message' },
          body: message, signal: aborter.signal, redirect: 'error',
        });
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/dns-message')) {
          await response.body?.cancel();
          throw new Error('DNS resolver rejected request');
        }
        if (!response.body) throw new Error('Empty DNS response');
        const reader = response.body.getReader();
        let answer = new Uint8Array();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (answer.length + value.length > 65535) throw new Error('Excessive DNS response');
            answer = joinBytes(answer, value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (answer.length < 12) throw new Error('Invalid DNS response');
        this.send(joinBytes(new Uint8Array([answer.length >> 8, answer.length & 255]), answer));
      })(), this.config.timeoutMs, () => aborter.abort());
    } finally { this.dnsAborter = null; }
  }

  stop(code = 1000, reason = 'Closed') {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.dnsAborter?.abort();
    closeSocket(this.socket);
    if (this.upstream) {
      this.upstream.reader.cancel().catch(() => {});
      try { this.upstream.writer.releaseLock(); } catch {}
    }
    try { if (this.ws.readyState === 1 || this.ws.readyState === 2) this.ws.close(code, reason); } catch {}
  }
}

export function upgrade(request, config, connect) {
  const earlyData = decodeEarlyData(request.headers.get('Sec-WebSocket-Protocol') || '');
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  new TunnelSession(server, config, connect).start(earlyData);
  return new Response(null, { status: 101, webSocket: client });
}

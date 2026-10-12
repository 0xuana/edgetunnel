const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export function joinBytes(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

export function uuidBytes(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('UUID must be a canonical UUID');
  }
  return Uint8Array.from(value.replaceAll('-', '').match(/../g), byte => parseInt(byte, 16));
}

// null means more bytes are needed; invalid complete fields throw immediately.
export function parseRequest(data, identity) {
  if (!data.length) return null;
  if (data[0] !== 0) throw new Error('Unsupported VLESS version');
  if (data.length < 18) return null;
  let difference = 0;
  for (let i = 0; i < 16; i++) difference |= data[i + 1] ^ identity[i];
  if (difference) throw new Error('Invalid VLESS identity');
  const commandOffset = 18 + data[17];
  if (data.length < commandOffset + 4) return null;
  const command = data[commandOffset];
  if (command !== 1 && command !== 2) throw new Error('Unsupported VLESS command');
  const port = data[commandOffset + 1] * 256 + data[commandOffset + 2];
  if (!port) throw new Error('Invalid destination port');
  if (command === 2 && port !== 53) throw new Error('UDP is supported only for DNS');
  const type = data[commandOffset + 3];
  let start = commandOffset + 4;
  let length;
  if (type === 1) length = 4;
  else if (type === 3) length = 16;
  else if (type === 2) {
    if (data.length <= start) return null;
    length = data[start++];
    if (!length) throw new Error('Empty destination hostname');
  } else throw new Error('Unsupported destination address type');
  if (data.length < start + length) return null;
  const address = data.slice(start, start + length);
  let hostname;
  if (type === 1) hostname = [...address].join('.');
  else if (type === 3) {
    hostname = Array.from({ length: 8 }, (_, i) => (address[i * 2] * 256 + address[i * 2 + 1]).toString(16)).join(':');
  } else {
    hostname = utf8.decode(address);
    if (!/^[a-z0-9._-]+$/i.test(hostname)) throw new Error('Invalid destination hostname');
  }
  return { command, port, type, address, hostname, payload: data.slice(start + length) };
}

export function decodeEarlyData(value) {
  if (!value) return new Uint8Array();
  if (value.length > 10924 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid or excessive early data');
  }
  const decoded = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (decoded.length > 8192) throw new Error('Excessive early data');
  return decoded;
}

export class DnsFrames {
  pending = new Uint8Array();
  push(chunk) {
    const bytes = joinBytes(this.pending, chunk);
    const messages = [];
    let offset = 0;
    while (bytes.length - offset >= 2) {
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 12) throw new Error('Invalid DNS packet length');
      if (bytes.length - offset < length + 2) break;
      messages.push(bytes.slice(offset + 2, offset + length + 2));
      offset += length + 2;
    }
    this.pending = bytes.slice(offset);
    return messages;
  }
}

export function parseSocks(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value.includes('://') ? value : `socks5://${value}`); }
  catch { throw new Error('Invalid SOCKS5 URL'); }
  if (url.protocol !== 'socks5:' || !url.hostname || url.pathname && url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SOCKS5 must be socks5://[user:password@]host:port');
  }
  let username, password;
  try { username = encoder.encode(decodeURIComponent(url.username)); password = encoder.encode(decodeURIComponent(url.password)); }
  catch { throw new Error('Invalid SOCKS5 credential encoding'); }
  if (Boolean(username.length) !== Boolean(password.length) || username.length > 255 || password.length > 255) {
    throw new Error('SOCKS5 credentials must contain 1–255 UTF-8 bytes each');
  }
  const port = Number(url.port || 1080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SOCKS5 port');
  return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port, username, password };
}

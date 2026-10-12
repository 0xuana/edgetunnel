import { connect } from 'cloudflare:sockets';
import { settings, sameToken } from './settings.mjs';
import { subscription } from './subscription.mjs';
import { upgrade } from './transport.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const wantsWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if (!wantsWebSocket && (url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
      return new Response('VLESS Worker is running\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
    let config;
    try { config = settings(env, url); }
    catch (error) {
      console.error('Worker configuration error:', error.message);
      return new Response('Worker configuration is incomplete or invalid', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    if (wantsWebSocket) {
      if (url.pathname !== config.path) return new Response('Not found', { status: 404 });
      try { return upgrade(request, config, connect); }
      catch { return new Response('Invalid WebSocket handshake', { status: 400 }); }
    }
    if (url.pathname === '/sub') {
      const authorization = request.headers.get('Authorization') || '';
      const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : url.searchParams.get('token') || '';
      if (!sameToken(provided, config.token)) return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
      return subscription(config, url.searchParams.get('format') || 'base64');
    }
    return new Response('Not found', { status: 404 });
  },
};

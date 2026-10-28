import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { Socket } from 'node:net';
import { createRunnerWebPreview } from '../core/runner-web-preview.mjs';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });
async function fixture(handler: http.RequestListener = (_req, res) => res.end('local')) {
  const server = http.createServer(handler);
  const connections = new Set<Socket>();
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => { for (const socket of connections) socket.destroy(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const claims = { use: 'web-preview', mid: 'machine', task: 'task', port, exp: Date.now() + 60000, jti: 'one' };
  const tickets = new Map([['valid', claims], ['other', { ...claims, jti: 'two' }]]);
  const proxy = createRunnerWebPreview({ machineId: 'machine', verifyTicket: async (ticket: string) => tickets.get(ticket) });
  cleanup.push(() => proxy.close());
  return { server, port, claims, tickets, proxy, request: (op: string, args: object = {}, signal?: AbortSignal) => proxy.request('task', op, { ticket: 'valid', path: '/', ...args }, signal) };
}
const decode = (result: { body: string }) => Buffer.from(result.body, 'base64').toString();

describe('Runner loopback preview transport', () => {
  it('rejects unsigned, expired, wrong task/machine and invalid-port tickets before connecting', async () => {
    const f = await fixture();
    await expect(f.request('http', { ticket: 'missing' })).rejects.toThrow('ticket');
    for (const patch of [{ exp: Date.now() - 1 }, { task: 'different' }, { mid: 'different' }, { port: 0 }, { port: 65536 }, { port: 1.5 }, { use: 'shell' }]) {
      f.tickets.set('bad', { ...f.claims, ...patch });
      await expect(f.request('http', { ticket: 'bad' })).rejects.toThrow('ticket');
    }
  });

  it('rejects paths that could change host or port and disallows CONNECT', async () => {
    const f = await fixture();
    for (const path of ['http://example.com/', '//127.0.0.1:22/', '/\\example.com/', '/a\r\nHost: example.com', '/a#fragment']) {
      await expect(f.request('http', { path })).rejects.toThrow();
    }
    await expect(f.request('http', { method: 'CONNECT' })).rejects.toThrow('method');
    await f.request('http');
    f.tickets.set('rebound', { ...f.claims, port: f.port === 65535 ? 65534 : f.port + 1 });
    await expect(f.request('http', { ticket: 'rebound' })).rejects.toThrow('binding');
  });

  it('preserves request bytes and decompresses response bytes without following redirects or forwarding secrets', async () => {
    let received: http.IncomingHttpHeaders = {};
    const f = await fixture((req, res) => {
      received = req.headers;
      if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.com/private' }); res.end(); return; }
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { res.writeHead(201, { 'content-encoding': 'gzip', 'content-type': 'application/octet-stream' }); res.end(gzipSync(Buffer.concat(chunks))); });
    });
    const bytes = Buffer.from([0, 255, 128, 64]);
    const result = await f.request('http', { method: 'PATCH', body: bytes.toString('base64'), headers: [['authorization', 'Bearer local-app-token'], ['x-opentandem-token', 'secret'], ['origin', 'https://preview.invalid'], ['referer', 'https://preview.invalid/a?b=1'], ['CONNECTION', 'x-private'], ['x-private', 'secret']] });
    expect(result.status).toBe(201);
    expect(result.body).toBe(bytes.toString('base64'));
    expect(Object.fromEntries(result.headers)['content-encoding']).toBeUndefined();
    expect(received.authorization).toBe('Bearer local-app-token');
    expect(received['x-opentandem-token']).toBeUndefined();
    expect(received['x-private']).toBeUndefined();
    expect(received.origin).toBe(`http://127.0.0.1:${f.port}`);
    expect(received.referer).toBe(`http://127.0.0.1:${f.port}/a?b=1`);
    const redirect = await f.request('http', { path: '/redirect' });
    expect(redirect.status).toBe(302);
    expect(Object.fromEntries(redirect.headers).location).toBe('http://example.com/private');
  });

  it('isolates cookie jars, hides HttpOnly and prevents browser overwrite while honoring visible deletions', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/login') res.setHeader('set-cookie', ['session=private; HttpOnly; Path=/', 'theme=dark; Path=/; Domain=127.0.0.1']);
      res.end(req.headers.cookie || '');
    });
    const login = await f.request('http', { path: '/login' });
    expect(login.cookies).toEqual(['theme=dark; Path=/; SameSite=Lax']);
    expect(Object.fromEntries(login.headers)['set-cookie']).toBeUndefined();
    expect(decode(await f.request('http', { headers: [['cookie', 'session=evil; theme=light']] }))).toBe('session=private; theme=light');
    expect(decode(await f.request('http'))).toBe('session=private; theme=light');
    expect(decode(await f.request('http', { ticket: 'other' }))).toBe('');
    expect(decode(await f.request('http', { headers: [], cookiesAuthoritative: true }))).toBe('session=private');
  });


  it('returns an explicit request-derived cookie path for the isolated bootstrap page', async () => {
    const f = await fixture((_, res) => { res.setHeader('set-cookie', 'theme=dark'); res.end(); });
    expect((await f.request('http', { path: '/app/login' })).cookies).toEqual(['theme=dark; Path=/app; SameSite=Lax']);
  });

  it('keeps cookies outside the browser document path during authoritative synchronization', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/login') res.setHeader('set-cookie', 'scoped=keep; Path=/app');
      res.end(req.headers.cookie || '');
    });
    await f.request('http', { path: '/login' });
    await f.request('http', { path: '/__ot_boot', cookiePath: '/__ot_boot', cookiesAuthoritative: true, headers: [] });
    expect(decode(await f.request('http', { path: '/app/page' }))).toBe('scoped=keep');
    await f.request('http', { path: '/resource', cookiePath: '/app/page', cookiesAuthoritative: true, headers: [] });
    expect(decode(await f.request('http', { path: '/app/page' }))).toBe('');
  });

  it('cancels HTTP work and close releases all pending requests', async () => {
    const f = await fixture(() => {});
    const abort = new AbortController();
    const pending = f.request('http', {}, abort.signal);
    setTimeout(() => abort.abort(), 20);
    await expect(pending).rejects.toThrow();
    const another = f.request('http');
    setTimeout(() => f.proxy.close(), 20);
    await expect(another).rejects.toThrow();
    await expect(f.request('http')).rejects.toThrow('closed');
  });

  it('renews a stable ticket without losing its cookies', async () => {
    const f = await fixture((req, res) => {
      if (req.url === '/login') res.setHeader('set-cookie', 'session=private; HttpOnly; Path=/');
      res.end(req.headers.cookie || '');
    });
    await f.request('http', { path: '/login' });
    f.tickets.set('renewed', { ...f.claims, exp: f.claims.exp + 1000 });
    expect(decode(await f.request('http', { ticket: 'renewed' }))).toBe('session=private');
  });

  it('expires an active HTTP request when its signed grant expires', async () => {
    const f = await fixture(() => {});
    f.claims.exp = Date.now() + 50;
    await expect(f.request('http')).rejects.toThrow('expired');
    await expect(f.request('http')).rejects.toThrow('ticket');
  });


  it('streams SSE before the HTTP response ends and binds its polling handle to the ticket', async () => {
    let response: http.ServerResponse | undefined;
    const f = await fixture((_, res) => {
      response = res;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'set-cookie': 'session=private; HttpOnly; Path=/' });
      res.write('event: ready\ndata: first\n\n');
    });
    const opened = await f.request('http');
    expect(opened.stream).toEqual(expect.any(String));
    expect(opened.body).toBeUndefined();
    expect(opened.cookies).toEqual([]);
    await expect(f.request('http_poll', { ticket: 'other', stream: opened.stream })).rejects.toThrow('Unknown preview stream');
    const first = await f.request('http_poll', { stream: opened.stream });
    expect(first.chunks.map((chunk: string) => Buffer.from(chunk, 'base64').toString()).join('')).toBe('event: ready\ndata: first\n\n');
    expect(first.done).toBe(false);
    const next = f.request('http_poll', { stream: opened.stream });
    response!.write('data: second\n\n');
    expect((await next).chunks.map((chunk: string) => Buffer.from(chunk, 'base64').toString()).join('')).toBe('data: second\n\n');
    const closing = f.request('http_poll', { stream: opened.stream });
    await f.request('http_close', { stream: opened.stream });
    expect((await closing).done).toBe(true);
    await expect(f.request('http_poll', { stream: opened.stream })).rejects.toThrow('Unknown preview stream');
  });

  it('decompresses SSE incrementally and reports end-of-stream without buffering until timeout', async () => {
    const event = 'data: compressed\n\n';
    const f = await fixture((_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
      res.end(gzipSync(event));
    });
    const opened = await f.request('http');
    expect(Object.fromEntries(opened.headers)['content-encoding']).toBeUndefined();
    const chunks: string[] = [];
    let ended = false;
    for (let i = 0; i < 3 && !ended; i++) {
      const polled = await f.request('http_poll', { stream: opened.stream });
      chunks.push(...polled.chunks);
      ended = polled.done;
    }
    expect(chunks.map(chunk => Buffer.from(chunk, 'base64').toString()).join('')).toBe(event);
    expect(ended).toBe(true);
  });

  it('aborts an SSE long poll without destroying its stream and cleans it up on manager close', async () => {
    const f = await fixture((_, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); });
    const opened = await f.request('http');
    const abort = new AbortController();
    const waiting = f.request('http_poll', { stream: opened.stream }, abort.signal);
    setTimeout(() => abort.abort(), 20);
    expect(await waiting).toEqual({ chunks: [], done: false });
    const final = f.request('http_poll', { stream: opened.stream });
    setTimeout(() => f.proxy.close(), 20);
    expect((await final).done).toBe(true);
  });

  it('upgrades with local origin/cookies, masks frames, receives fragments and binds socket to ticket', async () => {
    const f = await fixture((_, res) => { res.setHeader('set-cookie', ['session=private; HttpOnly; Path=/', 'theme=dark; Path=/']); res.end(); });
    let upgradeHeaders: http.IncomingHttpHeaders = {};
    const messages: Buffer[] = [];
    f.server.on('upgrade', (req, socket) => {
      upgradeHeaders = req.headers;
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nSec-WebSocket-Protocol: hot\r\n\r\n');
      socket.on('data', frame => {
        expect(frame[1] & 128).toBe(128);
        const length = frame[1] & 127;
        const payload = Buffer.alloc(length);
        for (let i = 0; i < length; i++) payload[i] = frame[6 + i] ^ frame[2 + i % 4];
        messages.push(payload);
        if ((frame[0] & 15) === 1) { socket.write(Buffer.from([0x01, 2, 104, 101])); socket.write(Buffer.from([0x80, 3, 108, 108, 111])); }
        if ((frame[0] & 15) === 2) socket.write(Buffer.concat([Buffer.from([0x82, payload.length]), payload]));
      });
    });
    await f.request('http');
    const opened = await f.request('ws_open', { protocols: ['hot'], cookie: 'session=evil; theme=light', cookiePath: '/', cookiesAuthoritative: true });
    expect(opened.protocol).toBe('hot');
    expect(upgradeHeaders.origin).toBe(`http://127.0.0.1:${f.port}`);
    expect(upgradeHeaders.cookie).toBe('session=private; theme=light');
    await expect(f.request('ws_send', { ticket: 'other', socket: opened.socket, data: 'attack' })).rejects.toThrow('Unknown');
    await f.request('ws_send', { socket: opened.socket, data: 'hello' });
    const polled = await f.request('ws_poll', { socket: opened.socket });
    expect(polled.events).toEqual([{ type: 'message', data: 'hello', binary: false }]);
    expect(messages[0].toString()).toBe('hello');
    const binary = Buffer.from([0, 255, 128]).toString('base64');
    await f.request('ws_send', { socket: opened.socket, data: binary, binary: true });
    expect((await f.request('ws_poll', { socket: opened.socket })).events).toEqual([{ type: 'message', data: binary, binary: true }]);
    const abort = new AbortController();
    const pending = f.request('ws_poll', { socket: opened.socket }, abort.signal);
    setTimeout(() => abort.abort(), 20);
    expect(await pending).toEqual({ events: [] });
    await f.request('ws_close', { socket: opened.socket, code: 1000, reason: 'done' });
  });
});

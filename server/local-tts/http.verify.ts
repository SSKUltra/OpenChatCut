import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { ViteDevServer } from 'vite';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { localTtsPlugin } from './http.ts';
import { LocalTtsService } from './service.ts';
import type { TtsWorkerFactory } from './transport.ts';

let hold = false;
let terminated = 0;
let starts = 0;
const workerFactory: TtsWorkerFactory = (emit) => ({
  send(command) {
    if (command.type === 'synthesize') {
      starts++;
      queueMicrotask(() => {
        emit({ type: 'progress', progress: { requestId: command.requestId, phase: 'generating', charactersDone: 0, charactersTotal: command.input.text.length } });
        if (!hold) emit({ type: 'audio', requestId: command.requestId, samples: Float32Array.from({ length: 240 }, (_, i) => Math.sin(i)) });
      });
    } else queueMicrotask(() => emit({ type: 'done', requestId: command.requestId }));
  },
  async terminate() { await delay(1); terminated++; },
});
const service = new LocalTtsService({ supported: true, workerFactory, inspect: async () => ({ root: '/unused', installed: true }) });
const app = createMiniConnect(() => undefined);
const server = createServer((req, res) => app.handle(req, res));
const fake = { middlewares: { use: app.use.bind(app) }, httpServer: server } as ViteDevServer;
const plugin = localTtsPlugin(service);
if (typeof plugin.configureServer !== 'function') throw new Error('missing local TTS plugin');
await plugin.configureServer.call(plugin as never, fake);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const headers = {
  Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin',
  'x-openchatcut-tts-request': randomUUID(), 'x-openchatcut-tts-owner': randomUUID(),
};
const post = (path: string, body: object, extra: HeadersInit = headers) => fetch(origin + path, {
  method: 'POST', headers: extra, body: JSON.stringify(body),
});
try {
  assert.equal((await fetch(origin + '/api/local-tts/status')).status, 200);
  assert.equal((await post('/api/local-tts/preview', {}, {})).status, 403);
  assert.equal((await post('/api/local-tts/preview', {}, { ...headers, Origin: 'https://evil.test' })).status, 403);
  assert.equal((await post('/api/local-tts/preview', {}, { ...headers, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/local-tts/preview', { voiceId: '../../unknown' })).status, 400);
  assert.equal(starts, 0, 'authorization and input checks precede worker creation');
  const preview = await post('/api/local-tts/preview', { voiceId: 'af_heart', text: 'ignored arbitrary text' });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'audio/wav');
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await preview.arrayBuffer());
  assert.equal(bytes.length, 524);
  hold = true;
  const active = post('/api/local-tts/preview', { voiceId: 'bf_emma' });
  for (let i = 0; i < 50 && !service.progress(headers['x-openchatcut-tts-request'], headers['x-openchatcut-tts-owner']); i++) await delay(2);
  assert.equal((await post('/api/local-tts/preview', { voiceId: 'af_heart' })).status, 409);
  assert.equal((await post('/api/local-tts/cancel', {}, { ...headers, 'x-openchatcut-tts-owner': randomUUID() })).status, 409);
  assert.equal((await post('/api/local-tts/cancel', {})).status, 200);
  assert.equal((await active).status, 400);
  assert.equal(terminated, 1);
  const controller = new AbortController();
  const disconnected = fetch(origin + '/api/local-tts/preview', {
    method: 'POST', headers, body: JSON.stringify({ voiceId: 'am_michael' }), signal: controller.signal,
  });
  const rejected = assert.rejects(disconnected, /abort/i);
  for (let i = 0; i < 50 && starts < 3; i++) await delay(2);
  controller.abort();
  await rejected;
  for (let i = 0; i < 50 && terminated < 2; i++) await delay(2);
  assert.equal(terminated, 2, 'client disconnect terminates the actual worker transport');
  hold = false;
  assert.equal((await post('/api/local-tts/preview', { voiceId: 'bm_george' })).status, 200);
} finally {
  server.close();
  server.closeAllConnections();
  await once(server, 'close');
  await service.unload();
}
console.log('local-tts HTTP: trusted origins, input, finite WAV, busy, owner-scoped cancel, disconnect and recovery passed');

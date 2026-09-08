import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { modelPackMutationRequestError } from '../plugins/model-packs.ts';
import { modelPackDefinition } from '../../shared/model-packs/catalog.ts';
import {
  LOCAL_TTS_PACK, LOCAL_TTS_SAMPLE, LOCAL_TTS_VOICES, parseLocalTtsInput,
  type LocalTtsInput, type LocalTtsProvenance,
} from '../../shared/local-tts/contract.ts';
import { LocalTtsService } from './service.ts';
import { NarrationWav, pcm16, wavHeader } from './wav.ts';

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
export function authorizeLocalTts(req: IncomingMessage, res: ServerResponse, mutation = true): boolean {
  if (!editorCredentialAuthorized(req, mutation)) { send(res, 403, { error: 'untrusted editor request' }); return false; }
  const rejected = mutation ? modelPackMutationRequestError(req.headers) : null;
  if (rejected) { send(res, rejected.status, { error: rejected.error }); return false; }
  return true;
}
function ownership(req: IncomingMessage): { requestId: string; owner: string } {
  const requestId = req.headers['x-openchatcut-tts-request'];
  const owner = req.headers['x-openchatcut-tts-owner'];
  if (typeof requestId !== 'string' || typeof owner !== 'string'
    || !/^[\w-]{16,80}$/.test(requestId) || !/^[\w-]{16,80}$/.test(owner)) {
    throw new Error('Local TTS requires request and owner identifiers');
  }
  return { requestId, owner };
}
function requestSignal(res: ServerResponse): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const closed = () => { if (!res.writableEnded) controller.abort(new Error('Local TTS client disconnected')); };
  res.once('close', closed);
  return { signal: controller.signal, release: () => res.off('close', closed) };
}
export function localTtsErrorStatus(error: unknown): number {
  return /busy|owner mismatch/.test(error instanceof Error ? error.message : '') ? 409 : 400;
}
export async function localNarration(
  service: LocalTtsService, req: IncomingMessage, res: ServerResponse, input: LocalTtsInput,
): Promise<void> {
  if (!authorizeLocalTts(req, res)) return;
  const owned = ownership(req);
  const cancellation = requestSignal(res);
  const wav = new NarrationWav();
  try {
    await service.synthesize(input, { ...owned, signal: cancellation.signal, onAudio: (samples) => wav.append(samples) });
    cancellation.signal.throwIfAborted();
    const saved = await wav.publish(cancellation.signal);
    const pack = modelPackDefinition(LOCAL_TTS_PACK)!;
    const provenance: LocalTtsProvenance = {
      provider: 'kokoro', modelId: pack.modelId, revision: pack.revision,
      runtime: 'kokoro-js@1.2.1', dtype: 'q8', voiceId: input.voiceId, speed: input.speed, sampleRate: 24000,
    };
    send(res, 200, { ...saved, provenance });
  } finally { cancellation.release(); await wav.discard(); }
}
async function preview(service: LocalTtsService, req: IncomingMessage, res: ServerResponse) {
  const owned = ownership(req);
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 8192) throw new Error('request body too large');
  }
  const body = JSON.parse(text) as Record<string, unknown>;
  const input = parseLocalTtsInput({ text: LOCAL_TTS_SAMPLE, voiceId: body.voiceId, speed: body.speed });
  const cancellation = requestSignal(res);
  const chunks: Buffer[] = [];
  let samples = 0;
  try {
    await service.synthesize(input, {
      ...owned, signal: cancellation.signal,
      onAudio: (audio) => { chunks.push(pcm16(audio)); samples += audio.length; },
    });
    cancellation.signal.throwIfAborted();
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' });
    res.end(Buffer.concat([wavHeader(samples), ...chunks]));
  } finally { cancellation.release(); }
}
export function localTtsPlugin(service: LocalTtsService): Plugin {
  return {
    name: 'openchatcut-local-tts',
    configureServer(server) {
      server.httpServer?.once('close', () => service.dispose());
      server.middlewares.use('/api/local-tts', (req, res) => {
        const path = (req.url ?? '').split('?')[0];
        void (async () => {
          const read = req.method === 'GET';
          if (!authorizeLocalTts(req, res, !read)) return;
          if (path === '/status' && read) {
            send(res, 200, { ...await service.status(), voices: LOCAL_TTS_VOICES }); return;
          }
          if (path === '/progress' && read) {
            const { requestId, owner } = ownership(req);
            send(res, 200, { progress: service.progress(requestId, owner) }); return;
          }
          if (path === '/cancel' && req.method === 'POST') {
            const { requestId, owner } = ownership(req);
            service.cancel(requestId, owner);
            send(res, 200, { ok: true }); return;
          }
          if (path === '/retry' && req.method === 'POST') { send(res, 200, await service.retry()); return; }
          if (path === '/preview' && req.method === 'POST') { await preview(service, req, res); return; }
          send(res, 404, { error: 'Not found' });
        })().catch((error: unknown) => send(res, localTtsErrorStatus(error), { error: error instanceof Error ? error.message : String(error) }));
      });
    },
  };
}

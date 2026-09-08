import type { LocalTtsProgress, LocalTtsVoiceId } from './contract.ts';

export interface LocalTtsClientOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LocalTtsProgress) => void;
}
export async function localTtsFetch(
  endpoint: '/generate/voice' | '/api/local-tts/preview',
  body: object,
  options: LocalTtsClientOptions = {},
): Promise<Response> {
  const headers = {
    'Content-Type': 'application/json',
    'x-openchatcut-tts-request': crypto.randomUUID(),
    'x-openchatcut-tts-owner': crypto.randomUUID(),
  };
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch('/api/local-tts/progress', { headers, signal: options.signal });
      if (response.ok) {
        const result = await response.json() as { progress: LocalTtsProgress | null };
        if (result.progress) options.onProgress?.(result.progress);
      }
    } catch { /* The completed-audio response remains authoritative. */ }
    finally { polling = false; }
  };
  const cancel = () => {
    void fetch('/api/local-tts/cancel', { method: 'POST', headers, body: '{}', keepalive: true }).catch(() => undefined);
  };
  options.signal?.throwIfAborted();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = options.onProgress ? setInterval(() => { void poll(); }, 500) : undefined;
  try {
    return await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal });
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
export async function previewLocalTts(voiceId: LocalTtsVoiceId, speed: number, options: LocalTtsClientOptions = {}): Promise<Blob> {
  const response = await localTtsFetch('/api/local-tts/preview', { voiceId, speed }, options);
  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error ?? 'Local TTS preview failed');
  }
  return response.blob();
}

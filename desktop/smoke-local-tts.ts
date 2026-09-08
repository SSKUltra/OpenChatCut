import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { uploadDir } from '../server/media-dir.ts';
import type { LocalTtsStatus } from '../shared/local-tts/contract.ts';

/** Opt-in real-weight acceptance. Installation must have happened explicitly. */
export async function runLocalTtsSmoke(origin: string): Promise<void> {
  const status = await fetch(`${origin}/api/local-tts/status`).then((r) => r.json()) as LocalTtsStatus;
  if (!status.available || !status.installed || status.loaded) throw new Error('Local TTS smoke requires an installed, unloaded model on Apple Silicon');
  const headers = {
    Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
    'x-openchatcut-tts-request': randomUUID(), 'x-openchatcut-tts-owner': randomUUID(),
  };
  const before = await readdir(uploadDir()).catch(() => []);
  const preview = await fetch(`${origin}/api/local-tts/preview`, {
    method: 'POST', headers, body: JSON.stringify({ voiceId: 'bf_emma', speed: 1 }),
  });
  if (!preview.ok) throw new Error(`Local TTS preview: ${await preview.text()}`);
  const bytes = Buffer.from(await preview.arrayBuffer());
  if (bytes.readUInt32LE(24) !== 24000 || bytes.readUInt16LE(22) !== 1 || bytes.length !== bytes.readUInt32LE(40) + 44) {
    throw new Error('Local TTS preview is not complete mono 24kHz PCM WAV');
  }
  const after = await readdir(uploadDir()).catch(() => []);
  if (before.toSorted().join('\n') !== after.toSorted().join('\n')) throw new Error('Local TTS preview polluted uploads');
  const response = await fetch(`${origin}/generate/voice`, {
    method: 'POST', headers,
    body: JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', text: 'Dr. Smith paid twelve dollars. This final phrase has no punctuation' }),
  });
  if (!response.ok) throw new Error(`Local TTS narration: ${await response.text()}`);
  const result = await response.json() as { path: string; durationSeconds: number; provenance: { voiceId: string } };
  const path = join(uploadDir(), result.path.split('/').at(-1)!);
  try {
    const audio = await readFile(path);
    if (audio.readUInt32LE(40) / 48000 !== result.durationSeconds || result.provenance.voiceId !== 'af_heart') {
      throw new Error('Local TTS narration has incorrect duration/provenance');
    }
    console.log(`[smoke] local TTS utility: UK preview ${bytes.length}B, US narration ${result.durationSeconds}s ${audio.length}B; no preview pollution`);
  } finally { await unlink(path); }
  const activeHeaders = { ...headers, 'x-openchatcut-tts-request': randomUUID() };
  const active = fetch(`${origin}/generate/voice`, {
    method: 'POST', headers: activeHeaders,
    body: JSON.stringify({ provider: 'kokoro', voiceId: 'af_heart', text: 'Keep every word of this long local narration. '.repeat(50) }),
  });
  let generating = false;
  for (let i = 0; i < 300; i++) {
    const progress = await fetch(`${origin}/api/local-tts/progress`, { headers: activeHeaders }).then((r) => r.json()) as { progress?: { phase: string } };
    if (progress.progress?.phase === 'generating') { generating = true; break; }
    await delay(20);
  }
  if (!generating) throw new Error('Local TTS utility did not report generation progress');
  await delay(300);
  const cancelledAt = performance.now();
  const cancelled = await fetch(`${origin}/api/local-tts/cancel`, { method: 'POST', headers: activeHeaders, body: '{}' });
  if (!cancelled.ok || (await active).status !== 400) throw new Error('Local TTS utility cancellation failed');
  const stopped = await fetch(`${origin}/api/local-tts/status`).then((r) => r.json()) as LocalTtsStatus;
  if (stopped.loaded) throw new Error('Cancelled utility retained its model');
  console.log(`[smoke] local TTS utility cancelled in ${Math.round(performance.now() - cancelledAt)}ms; worker unloaded`);
  for (const voiceId of ['am_michael', 'bm_george']) {
    const recovered = await fetch(`${origin}/api/local-tts/preview`, {
      method: 'POST', headers, body: JSON.stringify({ voiceId }),
    });
    if (!recovered.ok) throw new Error(`Local TTS utility did not recover: ${await recovered.text()}`);
    const audio = Buffer.from(await recovered.arrayBuffer());
    console.log(`[smoke] local TTS recovered ${voiceId}: ${audio.readUInt32LE(40) / 48000}s`);
  }
}

import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MODEL_PACKS, modelPackDefinition } from '../../shared/model-packs/catalog.ts';
import { parseLocalTtsInput, LOCAL_TTS_VOICES } from '../../shared/local-tts/contract.ts';
import { validateVoiceRequest } from '../plugins/voice-validation.ts';
import { __inspectModelPackForVerify } from '../plugins/model-packs.ts';
import { acquireModelPackUse, mutateModelPack } from '../plugins/model-pack-use.ts';
import { nativeInferenceBudget, nativeInferenceResidency } from '../native-inference-coordinator.ts';
import { boundedSynthesis, splitSource, TokenBudgetExceeded } from './chunks.ts';
import { LocalTtsService } from './service.ts';
import type { TtsWorkerFactory, WorkerEvent } from './transport.ts';
import { NarrationWav, pcm16, wavHeader } from './wav.ts';

const directory = resolve('.tmp', `local-tts-verify-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const input = parseLocalTtsInput({ text: 'Hello without final punctuation', voiceId: 'af_heart' });
assert.equal(input.speed, 1);
for (const voice of LOCAL_TTS_VOICES) assert.equal(parseLocalTtsInput({ ...input, voiceId: voice.id }).voiceId, voice.id);
for (const value of ['', 'hello', null, 0, 'af_missing']) assert.throws(() => parseLocalTtsInput({ ...input, voiceId: value }), /voiceId/);
for (const speed of [NaN, Infinity, 0, 0.49, 2.1, '1']) assert.throws(() => parseLocalTtsInput({ ...input, speed }), /speed/);
assert.throws(() => parseLocalTtsInput({ ...input, text: ' \n ' }), /text/);
for (const extra of [{ modelId: 'x' }, { stream: true }, { languageCode: 'en' }, { instructions: 'calm' }]) {
  assert.throws(() => validateVoiceRequest({ ...input, provider: 'kokoro', ...extra }), /only accepts/);
}
assert.equal(validateVoiceRequest({ ...input, provider: 'kokoro' }).sampleRate, 24000);
const pack = modelPackDefinition('kokoro-en')!;
assert.equal(pack.sizeBytes, 92_364_770);
assert.equal(pack.sizeBytes, pack.files.reduce((total, file) => total + file.sizeBytes, 0));
assert.equal(pack.revision, '1939ad2a8e416c0acfeecc08a694d14ef25f2231');
for (const entry of MODEL_PACKS) for (const file of entry.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);

for (const text of [
  'Dr. Smith paid $12.50 in 2026. The final phrase has no punctuation',
  'unpunctuated words '.repeat(150) + 'unique final tail',
  'a'.repeat(1500), '😀'.repeat(601), 'Line one.\n\nLine two! Here is a tail', ' '.repeat(1200) + 'Spoken tail',
]) {
  assert.equal(splitSource(text).join(''), text);
  const generated: string[] = [];
  for await (const chunk of boundedSynthesis(text, async (source) => {
    // Deterministic surrogate counts special tokens too; real tokenizer is
    // exercised by the opt-in runtime acceptance fixture, never downloaded here.
    if (Array.from(source).length + 2 > 512) throw new TokenBudgetExceeded(source.length + 2);
    return source;
  })) generated.push(chunk.source);
  assert.equal(generated.join(''), text, 'every source character must reach synthesis exactly once');
  assert.ok(generated.every((text) => !text.trim() || Array.from(text).length + 2 <= 512));
}
assert.equal(wavHeader(24000).readUInt32LE(40), 48000);
assert.throws(() => pcm16(new Float32Array([NaN])), /non-finite/);
assert.throws(() => pcm16(new Float32Array()), /empty/);
const waveform = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i / 20) * 0.8);
assert.equal(pcm16(waveform).readInt16LE(0), 0);
const wav = new NarrationWav(directory);
await wav.append(waveform);
await wav.append(waveform);
const published = await wav.publish();
assert.equal(published.durationSeconds, 0.2);
const bytes = await readFile(join(directory, published.path.split('/').at(-1)!));
assert.equal(bytes.length, 44 + 4800 * 2);
assert.equal(bytes.readUInt32LE(40), 4800 * 2);
const partial = new NarrationWav(directory);
await partial.append(waveform);
await partial.discard();
assert.ok((await readdir(directory)).every((name) => !name.endsWith('.partial')));
const interrupted = new NarrationWav(directory);
await interrupted.append(waveform);
await assert.rejects(interrupted.publish(AbortSignal.abort()), /abort/i);
await interrupted.discard();
assert.equal((await readdir(directory)).filter((name) => name.endsWith('.wav')).length, 1);

const inspectRoot = join(directory, 'fixture-model');
await mkdir(inspectRoot);
const fixtureBytes = Buffer.from('verified local model');
await writeFile(join(inspectRoot, 'model.bin'), fixtureBytes);
const fixturePack = {
  ...pack, modelId: 'fixture-model', files: [{
    path: 'model.bin', sizeBytes: fixtureBytes.length,
    sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
  }],
};
assert.equal((await __inspectModelPackForVerify(fixturePack, directory)).installed, true);
await writeFile(join(inspectRoot, 'model.bin'), Buffer.alloc(fixtureBytes.length));
assert.equal((await __inspectModelPackForVerify(fixturePack, directory)).installed, false, 'same-size corruption invalidates cached verification');

let spawned = 0;
let terminated = 0;
let emit: ((message: WorkerEvent) => void) | undefined;
let autoComplete = true;
const workerFactory: TtsWorkerFactory = (onMessage) => {
  spawned++;
  emit = onMessage;
  let id = '';
  return {
    send(command) {
      if (command.type === 'synthesize') {
        id = command.requestId;
        queueMicrotask(() => {
          onMessage({ type: 'progress', progress: { requestId: id, phase: 'generating', charactersDone: 0, charactersTotal: input.text.length } });
          if (autoComplete) onMessage({ type: 'audio', requestId: id, samples: waveform });
        });
      } else queueMicrotask(() => onMessage({ type: 'done', requestId: id }));
    },
    async terminate() { await delay(10); terminated++; },
  };
};
let installed = true;
const service = new LocalTtsService({
  supported: true, workerFactory, idleMs: 25, inspect: async () => ({ root: directory, installed }),
});
try {
  assert.equal((await service.status()).available, true, 'installed but unloaded is lazy-ready');
  assert.equal(spawned, 0);
  nativeInferenceBudget.claim(17, 'other-native-stack', 0);
  await assert.rejects(service.synthesize(input, { onAudio: () => undefined }), /busy/);
  nativeInferenceBudget.release('other-native-stack');
  assert.equal((await service.status()).available, true, 'resource contention does not disable the installed provider');
  await service.synthesize(input, { onAudio: () => undefined });
  await service.synthesize(input, { onAudio: () => undefined });
  assert.equal(spawned, 1, 'warm model reused');
  await mutateModelPack('kokoro-en', async () => { assert.equal(terminated, 1, 'idle worker stopped before pack mutation'); });
  assert.equal((await service.status()).loaded, false);
  installed = false;
  assert.equal((await service.status()).available, false);
  await assert.rejects(service.synthesize(input, { onAudio: () => undefined }), /Settings → Voice/);
  installed = true;
  autoComplete = false;
  const signal = new AbortController();
  const run = service.synthesize(input, { requestId: 'owned-request', owner: 'owner', signal: signal.signal, onAudio: () => undefined });
  const cancelled = assert.rejects(run, /cancel/);
  await delay(0);
  await assert.rejects(service.synthesize(input, { onAudio: () => undefined }), /busy/);
  await assert.rejects(mutateModelPack('kokoro-en', async () => undefined), /busy/);
  assert.throws(() => service.cancel('owned-request', 'not-owner'), /owner mismatch/);
  assert.equal(service.progress('owned-request', 'owner')?.phase, 'generating');
  signal.abort(new Error('cancel native work'));
  await cancelled;
  assert.equal(terminated, 2, 'cancellation waits for process termination before releasing lease');
  assert.equal(nativeInferenceBudget.activeCount, 0);
  assert.ok(!nativeInferenceResidency.residentKinds().includes('tts'));
  autoComplete = true;
  await service.synthesize(input, { onAudio: () => undefined });
  assert.equal(spawned, 3, 'worker recovers after cancellation');
  await delay(60);
  assert.equal((await service.status()).loaded, false, 'idle timer unloads model');
  assert.equal(terminated, 3);
  autoComplete = false;
  const failed = service.synthesize(input, { requestId: 'crash', onAudio: () => undefined });
  const rejected = assert.rejects(failed, /test crash/);
  await delay(0);
  emit?.({ type: 'error', requestId: 'crash', error: 'test crash' });
  await rejected;
  assert.equal((await service.status()).available, false);
  assert.equal((await service.retry()).available, true, 'explicit retry clears a failed runtime without downloading');
  assert.equal(nativeInferenceBudget.activeCount, 0);
  const release = acquireModelPackUse('kokoro-en');
  release(); release();
  await mutateModelPack('kokoro-en', async () => undefined);
} finally {
  service.dispose();
  await service.unload();
  await rm(directory, { recursive: true, force: true });
}
const unsupported = new LocalTtsService({ supported: false, workerFactory });
assert.equal((await unsupported.status()).state, 'unsupported');
await assert.rejects(unsupported.synthesize(input, { onAudio: () => undefined }), /Apple Silicon/);
unsupported.dispose();
const unreadable = new LocalTtsService({ supported: true, inspect: async () => { throw new Error('cache access denied'); } });
assert.equal((await unreadable.status()).state, 'error', 'cache errors must not prevent the app server from starting');
unreadable.dispose();
console.log('local-tts: catalog, input, lossless chunks, WAV, corruption, leases, ownership, hard cancel, idle and recovery passed');

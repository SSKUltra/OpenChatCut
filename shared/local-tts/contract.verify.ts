import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LOCAL_TTS_VOICES, type LocalTtsStatus } from './contract.ts';
import { buildSubmitVoiceArgs } from '../../src/agent/tools/generate-tool-input.ts';
import { submitVoice } from '../../src/generate/voice.ts';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels, applyLocalTtsStatus, capabilitiesPrompt, currentCaps } from '../../src/agent/capabilities.ts';
import { vendorConfigured, selectOptionLabel } from '../../src/components/settings/settingsSchema.ts';
import { VOICE_SETTINGS_GROUP } from '../../src/components/settings/settingsMediaProviders.ts';

const ready: LocalTtsStatus = { available: true, installed: true, supported: true, loaded: false, state: 'ready', settingsPath: 'voice/kokoro' };
const page = VOICE_SETTINGS_GROUP.vendors.find((page) => page.key === 'voice/kokoro')!;
const status = { keys: {}, caps: { voice: true }, models: {}, localTts: ready };
assert.equal(vendorConfigured(status, page), true);
assert.equal(vendorConfigured({ ...status, localTts: { ...ready, available: false } }, page), false);
assert.ok(!selectOptionLabel(status, VOICE_SETTINGS_GROUP.route!, { value: 'kokoro', label: 'Kokoro 本地' }).includes('未配置'));
applyLiveCaps({ voice: true });
applyLiveKeyStatus({});
applyLiveModels({ LOCAL_TTS_VOICE: 'bf_emma', LOCAL_TTS_SPEED: '1.25', PREFERRED_VOICE_VENDOR: 'kokoro' });
applyLocalTtsStatus(ready);
assert.match(capabilitiesPrompt(), /user default: Kokoro Local\(provider=kokoro\)/);
assert.match(capabilitiesPrompt(), /voiceId=bf_emma, speed=1.25/);
applyLocalTtsStatus({ ...ready, available: false, installed: false, state: 'absent' });
applyLiveCaps({ voice: false });
assert.equal(currentCaps().voice, false);
assert.ok(!capabilitiesPrompt().includes('Kokoro Local(provider=kokoro)'));
applyLiveKeyStatus({ ELEVENLABS_API_KEY: { configured: true } });
applyLiveCaps({ voice: true });
assert.match(capabilitiesPrompt(), /ElevenLabs\(provider=elevenlabs\)/);
for (const voice of LOCAL_TTS_VOICES) assert.equal(buildSubmitVoiceArgs({ provider: 'kokoro', text: 'test', voiceId: voice.id }).voiceId, voice.id);
assert.throws(() => buildSubmitVoiceArgs({ provider: 'kokoro', text: 'test', voiceId: 'af_heart', speed: '1' }), /speed/);
assert.throws(() => buildSubmitVoiceArgs({ provider: 'kokoro', text: 'test', voiceId: 'af_heart', modelId: 'cloud' }), /only accepts/);

const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  assert.equal(url, '/generate/voice');
  assert.ok(new Headers(init?.headers).get('x-openchatcut-tts-owner'));
  return Response.json({
    path: '/media/uploads/proof.wav', durationSeconds: 2.5,
    provenance: { provider: 'kokoro', voiceId: 'bf_emma', speed: 1.25, sampleRate: 24000 },
  });
};
try {
  const asset = await submitVoice({ provider: 'kokoro', text: 'test', voiceId: 'bf_emma' }, {
    fps: 30, width: 1920, height: 1080, items: [], selectedId: null, trackOrder: [], tracks: {},
  });
  assert.equal(asset.durationInFrames, 75);
  assert.deepEqual(asset.props?.localTts, { provider: 'kokoro', voiceId: 'bf_emma', speed: 1.25, sampleRate: 24000 });
  assert.equal(asset.kind, 'audio');
} finally { globalThis.fetch = oldFetch; }

const directory = resolve('.tmp', `local-tts-preferences-${randomUUID()}`);
const oldData = process.env.OPENCHATCUT_DATA_DIR;
const oldProfile = process.env.OPENCHATCUT_DEV_PROFILE_ID;
process.env.OPENCHATCUT_DATA_DIR = directory;
process.env.OPENCHATCUT_DEV_PROFILE_ID = randomUUID();
await mkdir(directory, { recursive: true });
try {
  const { setKeys, keyStatus, computeCaps } = await import('../../server/keystore.ts');
  await setKeys({ LOCAL_TTS_VOICE: 'am_michael', LOCAL_TTS_SPEED: '0.75', PREFERRED_VOICE_VENDOR: 'elevenlabs' });
  assert.equal(keyStatus().models.LOCAL_TTS_VOICE, 'am_michael');
  assert.equal(keyStatus().models.LOCAL_TTS_SPEED, '0.75');
  assert.equal(keyStatus().models.PREFERRED_VOICE_VENDOR, 'elevenlabs', 'preferences do not select local routing');
  assert.equal(computeCaps(true).voice, true);
  await assert.rejects(setKeys({ LOCAL_TTS_VOICE: 'not-real' }), /invalid LOCAL_TTS_VOICE/);
  await assert.rejects(setKeys({ LOCAL_TTS_SPEED: 'NaN' }), /SPEED/);
  await setKeys({ LOCAL_TTS_VOICE: '', LOCAL_TTS_SPEED: '' });
  assert.equal(keyStatus().models.LOCAL_TTS_VOICE, '');
} finally {
  if (oldData === undefined) delete process.env.OPENCHATCUT_DATA_DIR; else process.env.OPENCHATCUT_DATA_DIR = oldData;
  if (oldProfile === undefined) delete process.env.OPENCHATCUT_DEV_PROFILE_ID; else process.env.OPENCHATCUT_DEV_PROFILE_ID = oldProfile;
  await rm(directory, { recursive: true, force: true });
}
console.log('local-tts contract: keyless live routing, saved preferences, strict input and actual asset metadata passed');

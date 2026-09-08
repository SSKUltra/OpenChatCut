export const LOCAL_TTS_PACK = 'kokoro-en' as const;
export const LOCAL_TTS_SAMPLE = 'Hello! This is a short preview of local narration. Your words stay on this Mac.';
export const LOCAL_TTS_VOICES = [
  { id: 'af_heart', name: 'Heart', locale: 'en-US', gender: 'female' },
  { id: 'am_michael', name: 'Michael', locale: 'en-US', gender: 'male' },
  { id: 'bf_emma', name: 'Emma', locale: 'en-GB', gender: 'female' },
  { id: 'bm_george', name: 'George', locale: 'en-GB', gender: 'male' },
] as const;
export type LocalTtsVoiceId = typeof LOCAL_TTS_VOICES[number]['id'];
export type LocalTtsState = 'unsupported' | 'absent' | 'ready' | 'loading' | 'generating' | 'error';
export interface LocalTtsStatus {
  supported: boolean;
  available: boolean;
  installed: boolean;
  loaded: boolean;
  state: LocalTtsState;
  error?: string;
  settingsPath: 'voice/kokoro';
}
export interface LocalTtsInput {
  text: string;
  voiceId: LocalTtsVoiceId;
  speed: number;
}
export interface LocalTtsProgress {
  requestId: string;
  phase: 'loading' | 'generating';
  charactersDone: number;
  charactersTotal: number;
}
export interface LocalTtsProvenance {
  provider: 'kokoro';
  modelId: string;
  revision: string;
  runtime: 'kokoro-js@1.2.1';
  dtype: 'q8';
  voiceId: LocalTtsVoiceId;
  speed: number;
  sampleRate: 24000;
}
export function isLocalTtsVoice(value: unknown): value is LocalTtsVoiceId {
  return LOCAL_TTS_VOICES.some((voice) => voice.id === value);
}
export function parseLocalTtsInput(value: Record<string, unknown>): LocalTtsInput {
  if (typeof value.text !== 'string' || !value.text.trim()) throw new Error('text is required');
  if (!isLocalTtsVoice(value.voiceId)) throw new Error('Kokoro voiceId must be af_heart, am_michael, bf_emma, or bm_george');
  const speed = value.speed ?? 1;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) {
    throw new Error('Kokoro speed must be between 0.5 and 2');
  }
  return { text: value.text, voiceId: value.voiceId, speed };
}

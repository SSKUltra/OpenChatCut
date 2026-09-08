import { randomUUID } from 'node:crypto';
import { modelPackDefinition, modelPackInstallGuidance } from '../../shared/model-packs/catalog.ts';
import { LOCAL_TTS_PACK, type LocalTtsInput, type LocalTtsProgress, type LocalTtsStatus } from '../../shared/local-tts/contract.ts';
import { verifiedModelPack } from '../plugins/model-packs.ts';
import { acquireModelPackUse, registerModelPackUnloader } from '../plugins/model-pack-use.ts';
import {
  nativeInferenceBudget, nativeInferenceResidency, evictNativeInference, registerNativeEviction,
} from '../native-inference-coordinator.ts';
import { nodeTtsWorker } from './node-adapter.ts';
import type { TtsWorker, TtsWorkerFactory, WorkerEvent } from './transport.ts';

interface ActiveRequest {
  id: string;
  owner: string;
  controller: AbortController;
  progress: LocalTtsProgress;
}
export interface TtsSynthesisOptions {
  requestId?: string;
  owner?: string;
  signal?: AbortSignal;
  onAudio: (samples: Float32Array) => Promise<void> | void;
  onProgress?: (progress: LocalTtsProgress) => void;
}
export interface LocalTtsServiceOptions {
  workerFactory?: TtsWorkerFactory;
  supported?: boolean;
  idleMs?: number;
  inspect?: typeof verifiedModelPack;
}
export class LocalTtsService {
  private worker?: TtsWorker;
  private active?: ActiveRequest;
  private receive?: (event: WorkerEvent) => void;
  private fail?: (error: Error) => void;
  private idle?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private loaded = false;
  private error?: string;
  private stopping?: Promise<void>;
  private audioFlight: Promise<void> = Promise.resolve();
  private readonly options: LocalTtsServiceOptions;
  private readonly unregister: Array<() => void>;
  readonly supported: boolean;

  constructor(options: LocalTtsServiceOptions = {}) {
    this.options = options;
    this.supported = options.supported ?? (process.platform === 'darwin' && process.arch === 'arm64');
    this.unregister = [
      registerModelPackUnloader(LOCAL_TTS_PACK, async () => { await this.unload(); this.error = undefined; }),
      registerNativeEviction('tts', () => { void this.unload(); }),
    ];
  }
  async status(): Promise<LocalTtsStatus> {
    const base = { supported: this.supported, loaded: this.loaded, settingsPath: 'voice/kokoro' as const };
    if (!this.supported) return { ...base, available: false, installed: false, state: 'unsupported' };
    let pack: Awaited<ReturnType<typeof verifiedModelPack>>;
    try { pack = await (this.options.inspect ?? verifiedModelPack)(LOCAL_TTS_PACK); }
    catch (error) {
      return { ...base, installed: false, available: false, state: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    const error = pack.error ?? this.error;
    return {
      ...base, installed: pack.installed, available: pack.installed && !error && !this.disposed,
      state: this.active?.progress.phase ?? (pack.installed ? (error ? 'error' : 'ready') : (error ? 'error' : 'absent')),
      ...(error ? { error } : {}),
    };
  }
  progress(id: string, owner: string): LocalTtsProgress | null {
    const request = this.ownedRequest(id, owner);
    return request ? { ...request.progress } : null;
  }
  cancel(id: string, owner: string): void {
    this.ownedRequest(id, owner)?.controller.abort(new Error('Local TTS cancelled'));
  }
  async retry(): Promise<LocalTtsStatus> {
    if (this.active) throw new Error('Local TTS is busy');
    await this.unload();
    this.error = undefined;
    return this.status();
  }
  private ownedRequest(id: string, owner: string): ActiveRequest | undefined {
    if (this.active?.id !== id) return;
    if (!owner || this.active.owner !== owner) throw new Error('Local TTS request owner mismatch');
    return this.active;
  }
  async synthesize(input: LocalTtsInput, options: TtsSynthesisOptions): Promise<void> {
    if (this.disposed) throw new Error('Local TTS service is closed');
    if (!this.supported) throw new Error('Local Kokoro requires an Apple Silicon Mac');
    if (this.active) throw new Error('Local TTS is busy; wait for the current synthesis or cancel it');
    options.signal?.throwIfAborted();
    const request: ActiveRequest = {
      id: options.requestId ?? randomUUID(), owner: options.owner ?? randomUUID(), controller: new AbortController(),
      progress: { requestId: options.requestId ?? '', phase: 'loading', charactersDone: 0, charactersTotal: input.text.length },
    };
    request.progress.requestId = request.id;
    this.active = request;
    this.error = undefined;
    clearTimeout(this.idle);
    const abort = () => request.controller.abort(options.signal?.reason ?? new Error('Local TTS cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    let releasePack: (() => void) | undefined;
    let releaseResidency: (() => void) | undefined;
    let budgetClaimed = false;
    let workerStarted = false;
    try {
      releasePack = acquireModelPackUse(LOCAL_TTS_PACK);
      const pack = await (this.options.inspect ?? verifiedModelPack)(LOCAL_TTS_PACK);
      if (!pack.installed) throw new Error(`${pack.error ?? 'Kokoro model is not installed'}. ${modelPackInstallGuidance([{ id: LOCAL_TTS_PACK }])}`);
      request.controller.signal.throwIfAborted();
      await this.stopping;
      nativeInferenceBudget.claim(0, request.id, Buffer.byteLength(input.text));
      budgetClaimed = true;
      releaseResidency = nativeInferenceResidency.claim(
        'tts', modelPackDefinition(LOCAL_TTS_PACK)!.recommendedMemoryBytes, evictNativeInference,
      );
      workerStarted = true;
      await this.runWorker(request, pack.root, input, options);
      this.loaded = true;
    } catch (error) {
      if (workerStarted && !request.controller.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      await this.unload();
      throw error;
    } finally {
      await this.audioFlight;
      options.signal?.removeEventListener('abort', abort);
      this.receive = undefined;
      this.fail = undefined;
      this.active = undefined;
      releaseResidency?.();
      if (budgetClaimed) nativeInferenceBudget.release(request.id);
      releasePack?.();
      if (this.worker) {
        this.idle = setTimeout(() => { void this.unload(); }, this.options.idleMs ?? 5 * 60_000);
        this.idle.unref();
      }
    }
  }
  private runWorker(request: ActiveRequest, root: string, input: LocalTtsInput, options: TtsSynthesisOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(request.controller.signal.reason);
      const finish = (error?: Error) => {
        request.controller.signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      request.controller.signal.addEventListener('abort', abort, { once: true });
      this.fail = (error) => finish(error);
      this.receive = (event) => {
        if (request.controller.signal.aborted) return;
        if (event.type === 'progress') {
          if (event.progress.requestId !== request.id) return;
          request.progress = event.progress;
          this.loaded = event.progress.phase === 'generating';
          options.onProgress?.(event.progress);
        } else if (event.requestId === request.id) {
          if (event.type === 'done') finish();
          else if (event.type === 'error') finish(new Error(event.error));
          else {
            this.audioFlight = Promise.resolve().then(() => options.onAudio(event.samples)).then(() => {
              if (!request.controller.signal.aborted) this.worker?.send({ type: 'ack', requestId: request.id });
            }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
          }
        }
      };
      if (!this.worker) {
        const factory = this.options.workerFactory ?? nodeTtsWorker;
        const worker = factory(
          (event) => { if (this.worker === worker) this.receive?.(event); },
          (error) => {
            if (this.worker !== worker) return;
            this.worker = undefined;
            this.loaded = false;
            this.fail?.(error);
          },
        );
        this.worker = worker;
      }
      if (request.controller.signal.aborted) abort();
      else this.worker.send({ type: 'synthesize', requestId: request.id, root, input });
    });
  }
  async unload(): Promise<void> {
    clearTimeout(this.idle);
    const worker = this.worker;
    this.worker = undefined;
    this.loaded = false;
    if (worker) this.stopping = worker.terminate();
    await this.stopping;
    nativeInferenceResidency.forget('tts');
  }
  dispose(): void {
    this.disposed = true;
    this.active?.controller.abort(new Error('Local TTS service is shutting down'));
    for (const unregister of this.unregister) unregister();
    void this.unload();
  }
}

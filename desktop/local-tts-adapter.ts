import { app, utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import type { TtsWorkerFactory, WorkerEvent } from '../server/local-tts/transport.ts';
import { LocalTtsService } from '../server/local-tts/service.ts';

export const electronTtsWorker: TtsWorkerFactory = (onMessage, onExit) => {
  const worker = utilityProcess.fork(fileURLToPath(new URL('./local-tts-worker.mjs', import.meta.url)), [], {
    serviceName: 'OpenChatCut Local TTS', stdio: 'pipe',
  });
  let stderr = '';
  worker.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  worker.on('message', (message: WorkerEvent) => onMessage(message));
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  worker.once('exit', (code) => onExit(new Error(`Local TTS utility exited (${code}): ${stderr}`)));
  return {
    send: (message) => worker.postMessage(message),
    terminate: async () => {
      const pid = worker.pid;
      worker.kill();
      // A native ONNX call cannot observe an AbortSignal. Do not let a stuck
      // utility retain CPU/model ownership indefinitely after cancellation.
      const fallback = setTimeout(() => {
        if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
        }
      }, 250);
      fallback.unref();
      try { await exited; } finally { clearTimeout(fallback); }
    },
  };
};
export function createElectronTts(): LocalTtsService {
  const service = new LocalTtsService({ workerFactory: electronTtsWorker });
  app.once('before-quit', () => service.dispose());
  return service;
}

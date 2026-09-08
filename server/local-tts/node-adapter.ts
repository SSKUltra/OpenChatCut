import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TtsWorkerFactory, WorkerEvent } from './transport.ts';

export const nodeTtsWorker: TtsWorkerFactory = (onMessage, onExit) => {
  const worker = fork(fileURLToPath(new URL('./node-worker.ts', import.meta.url)), [], {
    serialization: 'advanced', execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  worker.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  worker.on('message', (message: WorkerEvent) => onMessage(message));
  worker.once('error', onExit);
  const exited = new Promise<void>((resolve) => worker.once('close', () => resolve()));
  worker.once('exit', (code) => onExit(new Error(`Local TTS worker exited (${code}): ${stderr}`)));
  return { send: (message) => worker.send(message), terminate: async () => { worker.kill('SIGKILL'); await exited; } };
};

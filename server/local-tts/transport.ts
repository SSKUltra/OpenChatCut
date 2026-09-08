import type { LocalTtsInput, LocalTtsProgress } from '../../shared/local-tts/contract.ts';

export type WorkerCommand =
  | { type: 'synthesize'; requestId: string; root: string; input: LocalTtsInput }
  | { type: 'ack'; requestId: string };
export type WorkerEvent =
  | { type: 'progress'; progress: LocalTtsProgress }
  | { type: 'audio'; requestId: string; samples: Float32Array }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; error: string };
export interface TtsWorker {
  send(command: WorkerCommand): void;
  terminate(): Promise<void>;
}
export type TtsWorkerFactory = (
  onMessage: (message: WorkerEvent) => void,
  onExit: (error: Error) => void,
) => TtsWorker;

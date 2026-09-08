import { loadLocalKokoro } from './runtime.ts';
import { boundedSynthesis } from './chunks.ts';
import type { WorkerCommand, WorkerEvent } from './transport.ts';

export function createWorkerCore(send: (message: WorkerEvent) => void): (command: WorkerCommand) => void {
  let model: Awaited<ReturnType<typeof loadLocalKokoro>> | undefined;
  let root: string | undefined;
  let active: string | undefined;
  let acknowledge: (() => void) | undefined;
  async function synthesize(command: Extract<WorkerCommand, { type: 'synthesize' }>) {
    const { requestId, input } = command;
    if (active) throw new Error('Local TTS worker is busy');
    active = requestId;
    let charactersDone = 0;
    const progress = (phase: 'loading' | 'generating') => send({
      type: 'progress', progress: { requestId, phase, charactersDone, charactersTotal: input.text.length },
    });
    try {
      if (!model || root !== command.root) {
        progress('loading');
        await model?.model.dispose();
        model = await loadLocalKokoro(command.root);
        root = command.root;
      }
      progress('generating');
      const engine = model;
      for await (const chunk of boundedSynthesis(input.text, (text) => engine.generate(text, { voice: input.voiceId, speed: input.speed }))) {
        if (chunk.audio) {
          if (chunk.audio.sampling_rate !== 24000) throw new Error('Unexpected Kokoro sample rate');
          const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
          send({ type: 'audio', requestId, samples: chunk.audio.audio });
          await acknowledged;
        }
        charactersDone += chunk.source.length;
        progress('generating');
      }
      send({ type: 'done', requestId });
    } finally { active = undefined; acknowledge = undefined; }
  }
  return (command) => {
    if (command.type === 'ack') {
      if (active === command.requestId) acknowledge?.();
      return;
    }
    void synthesize(command).catch((error: unknown) => send({
      type: 'error', requestId: command.requestId, error: error instanceof Error ? error.message : String(error),
    }));
  };
}

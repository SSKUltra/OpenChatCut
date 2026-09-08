import { createWorkerCore } from '../server/local-tts/worker-core.ts';
import type { WorkerCommand } from '../server/local-tts/transport.ts';

const port = process.parentPort;
if (!port) throw new Error('Local TTS requires an Electron utility process');
const receive = createWorkerCore((message) => port.postMessage(message));
port.on('message', (event: { data: WorkerCommand }) => receive(event.data));

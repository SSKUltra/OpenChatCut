import { createWorkerCore } from './worker-core.ts';
import type { WorkerCommand } from './transport.ts';

const receive = createWorkerCore((message) => process.send?.(message));
process.on('message', (message: WorkerCommand) => receive(message));
process.once('disconnect', () => process.exit(0));

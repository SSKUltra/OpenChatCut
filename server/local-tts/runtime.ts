import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import type { KokoroTTS as KokoroModel } from 'kokoro-js';
import { MAX_TOKENS, TokenBudgetExceeded } from './chunks.ts';

type Tokenizer = KokoroModel['tokenizer'];
interface TransformersRuntime {
  env: {
    allowRemoteModels: boolean; allowLocalModels: boolean; useBrowserCache: boolean;
    useFSCache: boolean; localModelPath: string;
  };
  PreTrainedTokenizer: new (json: unknown, config: unknown) => Tokenizer;
}

export async function loadLocalKokoro(root: string): Promise<KokoroModel> {
  const require = createRequire(import.meta.url);
  const { KokoroTTS }: typeof import('kokoro-js') = require('kokoro-js');
  // Kokoro CJS has its own Transformers 3 instance. App Transformers 4 must never
  // be imported into this helper, and Kokoro's exported env only exposes wasmPaths.
  const runtime: TransformersRuntime = createRequire(require.resolve('kokoro-js'))('@huggingface/transformers');
  Object.assign(runtime.env, {
    allowRemoteModels: false, allowLocalModels: true, useBrowserCache: false,
    useFSCache: false, localModelPath: `${dirname(root)}/`,
  });
  class StrictTokenizer extends runtime.PreTrainedTokenizer {
    override _call(text: Parameters<Tokenizer['_call']>[0], options: Parameters<Tokenizer['_call']>[1] = {}) {
      const result = super._call(text, { ...options, truncation: false, add_special_tokens: true, return_tensor: true });
      if (Array.isArray(result.input_ids)) throw new Error('Kokoro tokenizer did not return a tensor');
      const count = result.input_ids.dims.at(-1);
      if (!count || count < 2) throw new Error('Invalid Kokoro token count');
      if (count > MAX_TOKENS) throw new TokenBudgetExceeded(count);
      return result;
    }
  }
  const tokenizer = new StrictTokenizer(
    JSON.parse(await readFile(join(root, 'tokenizer.json'), 'utf8')),
    JSON.parse(await readFile(join(root, 'tokenizer_config.json'), 'utf8')),
  );
  const loaded = await KokoroTTS.from_pretrained(basename(root), { dtype: 'q8', device: 'cpu' });
  return new KokoroTTS(loaded.model, tokenizer);
}

export const MAX_TOKENS = 512;
export class TokenBudgetExceeded extends Error {
  constructor(tokens: number) { super(`Kokoro token budget exceeded: ${tokens}/${MAX_TOKENS}`); }
}

/** Keep exact source spans. Prefer sentences/clauses, then words, then codepoints. */
export function splitSource(text: string): [string, string] {
  const middle = text.length / 2;
  const low = text.length / 4;
  const high = text.length * 3 / 4;
  for (const boundary of [/[.!?;:\n][”"')\]]*\s+/gu, /\s+/gu]) {
    let best = -1;
    for (const match of text.matchAll(boundary)) {
      const end = match.index + match[0].length;
      if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|[A-Z])\.\s*$/u.test(text.slice(Math.max(0, end - 16), end))) continue;
      if (end >= low && end <= high && (best < 0 || Math.abs(end - middle) < Math.abs(best - middle))) best = end;
    }
    if (best > 0) return [text.slice(0, best), text.slice(best)];
  }
  const points = Array.from(text);
  if (points.length < 2) throw new Error('Kokoro cannot safely tokenize this input');
  const index = Math.floor(points.length / 2);
  return [points.slice(0, index).join(''), points.slice(index).join('')];
}

export async function* boundedSynthesis<T>(
  text: string,
  generate: (source: string) => Promise<T>,
): AsyncGenerator<{ source: string; audio: T | null }> {
  if (!text.trim()) { yield { source: text, audio: null }; return; }
  // This preliminary bound controls phonemizer work, NOT the model token budget.
  if (text.length <= 1000) {
    try { yield { source: text, audio: await generate(text) }; return; }
    catch (error) { if (!(error instanceof TokenBudgetExceeded)) throw error; }
  }
  for (const part of splitSource(text)) yield* boundedSynthesis(part, generate);
}

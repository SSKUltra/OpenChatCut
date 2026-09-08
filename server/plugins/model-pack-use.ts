import type { ModelPackId } from '../../shared/model-packs/catalog.ts';

interface PackUse { active: number; mutating: boolean; unloaders: Set<() => void | Promise<void>> }
const uses = new Map<ModelPackId, PackUse>();
function state(id: ModelPackId): PackUse {
  let entry = uses.get(id);
  if (!entry) { entry = { active: 0, mutating: false, unloaders: new Set() }; uses.set(id, entry); }
  return entry;
}
export function registerModelPackUnloader(id: ModelPackId, unload: () => void | Promise<void>): () => void {
  const entry = state(id);
  entry.unloaders.add(unload);
  return () => entry.unloaders.delete(unload);
}
/** Admission is synchronous, before inspection or any filesystem await. */
export function acquireModelPackUse(id: ModelPackId): () => void {
  const entry = state(id);
  if (entry.mutating) throw new Error(`Model pack ${id} is being changed; retry after installation`);
  entry.active++;
  let released = false;
  return () => { if (!released) { released = true; entry.active--; } };
}
export async function mutateModelPack<T>(id: ModelPackId, action: () => Promise<T>): Promise<T> {
  const entry = state(id);
  if (entry.active || entry.mutating) throw new Error(`Model pack ${id} is busy; stop local synthesis before changing it`);
  entry.mutating = true;
  try {
    for (const unload of entry.unloaders) await unload();
    return await action();
  } finally { entry.mutating = false; }
}

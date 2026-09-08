import { NativeInferenceBudget } from '../desktop/native-inference-budget.ts';
import { NativeInferenceResidency, type NativeInferenceKind } from '../desktop/native-inference-residency.ts';

export const nativeInferenceBudget = new NativeInferenceBudget();
export const nativeInferenceResidency = new NativeInferenceResidency();
const evictions = new Map<NativeInferenceKind, () => void>();
export function registerNativeEviction(kind: NativeInferenceKind, evict: () => void): () => void {
  evictions.set(kind, evict);
  return () => { if (evictions.get(kind) === evict) evictions.delete(kind); };
}
export function evictNativeInference(kind: NativeInferenceKind): void {
  evictions.get(kind)?.();
  nativeInferenceResidency.forget(kind);
}

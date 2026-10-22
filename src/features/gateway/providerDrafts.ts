import { useSyncExternalStore } from 'react';
import type { WireApi } from './types';

export interface ProviderDraft { id: string; name: string; baseUrl: string; wire: WireApi; authMode?: 'key' | 'none'; models: string }
// Window memory only: never storage, and the whitelist excludes every secret field.
const drafts = new Map<string, ProviderDraft>();
const saves = new Set<string>();
const listeners = new Set<() => void>();
function changed() { listeners.forEach((listener) => listener()); }
export function readProviderDraft(target: string): ProviderDraft | undefined { return drafts.get(target); }
export function writeProviderDraft(target: string, form: ProviderDraft) {
  const { id, name, baseUrl, wire, models, authMode } = form;
  drafts.set(target, { id, name, baseUrl, wire, models, ...(authMode ? { authMode } : {}) });
}
export function clearProviderDraft(target: string) { drafts.delete(target); }
export function beginProviderSave(target: string): boolean {
  if (saves.has(target)) return false;
  saves.add(target); changed(); return true;
}
export function endProviderSave(target: string) { saves.delete(target); changed(); }
export function useProviderSaving(target?: string) {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => target ? saves.has(target) : saves.size > 0);
}

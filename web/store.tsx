/**
 * The one door to localStorage. A blocked store (private mode, blocked site data) throws on
 * use; then choices live in memory for the page's life and `useStorageBlocked` tells the UI.
 */
import { useState, useSyncExternalStore } from 'react';

// A value (or null for "removed") written while the store would not take it.
const memory = new Map<string, string | null>();
let blocked = false;
const listeners = new Set<() => void>();
const block = () => {
  if (blocked) return;
  blocked = true;
  listeners.forEach((fn) => fn());
};

export const store = {
  get(key: string): string | null {
    if (memory.has(key)) return memory.get(key)!;
    try { return localStorage.getItem(key); } catch { block(); return null; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); memory.delete(key); } catch { block(); memory.set(key, value); }
  },
  remove(key: string) {
    try { localStorage.removeItem(key); memory.delete(key); } catch { block(); memory.set(key, null); }
  },
};

export const isStorageBlocked = () => blocked;
/** True once any storage call has failed this page load. */
export const useStorageBlocked = () =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => void listeners.delete(fn); }, isStorageBlocked);

/** Test hook: forget the blocked flag and the in-memory copies. */
export const resetStore = () => { blocked = false; memory.clear(); };

/** One quiet notice per page load when the store is unavailable. Clears the phone TabBar. */
export function StorageNotice() {
  const blockedNow = useStorageBlocked();
  const [gone, setGone] = useState(false);
  return (
    <>
      <span role="status" className="sr-only">
        {blockedNow && !gone ? MESSAGE : ''}
      </span>
      {blockedNow && !gone ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+68px)] z-[60] flex justify-center p-3 md:bottom-[env(safe-area-inset-bottom)]">
          <button
            type="button"
            onClick={() => setGone(true)}
            className="pointer-events-auto flex max-w-md items-center gap-3 rounded-card bg-elevated px-3 py-2 text-left text-body text-fg shadow-elevated"
          >
            <span>{MESSAGE}</span>
            <span aria-label="Dismiss" className="text-muted">×</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
const MESSAGE = 'Storage is unavailable, so your choices last until you reload.';

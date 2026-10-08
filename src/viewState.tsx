import { useCallback, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';

const prefix = 'oops-view-v3:';
const values = new Map<string, unknown>();
const subscribers = new Map<string, Set<() => void>>();

function read<T>(key: string, initial: T | (() => T)): T {
  if (values.has(key)) return values.get(key) as T;
  let value = typeof initial === 'function' ? (initial as () => T)() : initial;
  try {
    const saved = sessionStorage.getItem(prefix + key);
    if (saved !== null) value = JSON.parse(saved) as T;
  } catch { /* An unavailable browser store must not block drafting. */ }
  values.set(key, value);
  return value;
}

/** Navigation can unmount a page without discarding its local draft. */
export function useViewState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const subscribe = useCallback((listener: () => void) => {
    const listeners = subscribers.get(key) || new Set<() => void>();
    listeners.add(listener); subscribers.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(key); };
  }, [key]);
  const snapshot = useCallback(() => read(key, initialRef.current), [key]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const current = read(key, initialRef.current);
    const updated = typeof next === 'function' ? (next as (previous: T) => T)(current) : next;
    if (Object.is(current, updated)) return;
    values.set(key, updated);
    try { sessionStorage.setItem(prefix + key, JSON.stringify(updated)); } catch { /* Keep the in-memory draft. */ }
    subscribers.get(key)?.forEach(listener => listener());
  }, [key]);
  return [value, setValue];
}

export function clearViewState() {
  values.clear();
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i));
    keys.forEach(key => { if (key?.startsWith(prefix)) sessionStorage.removeItem(key); });
  } catch { /* Memory reset still works when storage is blocked. */ }
  subscribers.forEach(listeners => listeners.forEach(listener => listener()));
}

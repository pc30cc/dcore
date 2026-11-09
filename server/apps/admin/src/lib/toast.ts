/**
 * Short notices after an action ("Saved", "Turned off"), shown for a few
 * seconds in a polite live region. A tiny store: any code may push one.
 */

export interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  text: string;
}

let toasts: readonly Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function toastList(): readonly Toast[] {
  return toasts;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((toast) => toast.id !== id);
  emit();
}

export function showToast(text: string, tone: Toast['tone'] = 'success', ms = 4_000): void {
  const id = next++;
  toasts = [...toasts.slice(-2), { id, tone, text }];
  emit();
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), ms);
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

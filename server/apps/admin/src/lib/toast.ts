/**
 * Short notices after an action ("Saved", "Turned off"), shown for a few
 * seconds in a polite live region. A tiny store: any code may push one.
 *
 * A notice holds how to word it, not finished text: the Toaster words it on
 * each render with the panel's language of that moment, so a notice on
 * screen, or one pushed by a request that was sent before a language
 * switch, is always in the language (and direction) of the layout around it.
 */

import type { Locale } from '@app/shared';
import type { Translate } from '@/i18n/translate';

/** Words a notice: `t` puts each string value in its own bidi isolate. */
export type ToastText = (t: Translate, locale: Locale) => string;

export interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  text: ToastText;
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

export function showToast(text: ToastText, tone: Toast['tone'] = 'success', ms = 4_000): void {
  const id = next++;
  toasts = [...toasts.slice(-2), { id, tone, text }];
  emit();
  if (typeof window !== 'undefined') window.setTimeout(() => dismissToast(id), ms);
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetToastsForTests(): void {
  toasts = [];
  emit();
}

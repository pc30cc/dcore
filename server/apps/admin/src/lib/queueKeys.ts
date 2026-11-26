import { useEffect, useRef } from 'react';

/**
 * The review queues' keys: A approves the focused item, R rejects it (opens
 * the reason picker), J and K move to the next and the previous one. Read
 * by `event.code`, the key's place on the keyboard, so a Persian or Turkish
 * layout works the same; J and K keep their meaning in a right-to-left
 * page.
 *
 * A key does nothing while typing (a text field, a select, an editable
 * region), with Ctrl, Meta or Alt held, when something else handled it
 * already, while a dialog or menu is open (those keep their own keys), or
 * when it repeats from being held down: one press decides one item.
 */

export interface QueueKeyHandlers {
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  onPrevious?: (() => void) | undefined;
  /** False: the keys are off (no permission, nothing loaded). */
  enabled?: boolean;
}

const TYPING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/** Whether a key press belongs to something other than the queue. */
export function queueKeyIgnored(event: KeyboardEvent): boolean {
  if (event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return true;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(TYPING)) return true;
  return document.querySelector(OVERLAY) !== null;
}

export function useQueueKeys(handlers: QueueKeyHandlers): void {
  // The latest handlers, without adding and removing the listener on every render.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const current = latest.current;
      if (current.enabled === false || queueKeyIgnored(event)) return;
      const action = { KeyA: current.onApprove, KeyR: current.onReject, KeyJ: current.onNext, KeyK: current.onPrevious }[event.code];
      if (!action) return;
      event.preventDefault();
      action();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

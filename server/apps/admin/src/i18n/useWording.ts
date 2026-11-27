import { useCallback, useState } from 'react';
import type { Wording } from './translate';

/**
 * State holding how to word a notice, for <Worded> to word when it is
 * drawn. The setter takes the wording itself (a function), never an
 * updater of the state before it.
 */
export function useWording(): [Wording | null, (text: Wording | null) => void] {
  const [held, setHeld] = useState<{ text: Wording } | null>(null);
  const set = useCallback((text: Wording | null) => setHeld(text && { text }), []);
  return [held?.text ?? null, set];
}

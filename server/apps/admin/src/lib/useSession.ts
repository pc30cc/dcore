import { useSyncExternalStore } from 'react';
import { sessionState, subscribeSession, type SessionState } from './session';

export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, sessionState, sessionState);
}

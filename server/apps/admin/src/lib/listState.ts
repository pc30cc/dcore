import { useLocation } from 'react-router';

/**
 * The list view a detail page was opened from: the list's query string
 * (its view or filter; never search text, which stays out of URLs), passed
 * in the navigation's state so the page's back link and its "done" return
 * to the same view.
 */
export interface FromList {
  from: string;
}

export function listState(search: string): FromList {
  return { from: search };
}

/** The query string of the list this page came from ('' when opened directly). */
export function useFromList(): string {
  const state: unknown = useLocation().state;
  const from = state !== null && typeof state === 'object' && 'from' in state ? state.from : '';
  return typeof from === 'string' && /^\?[\w=&%.-]*$/.test(from) ? from : '';
}

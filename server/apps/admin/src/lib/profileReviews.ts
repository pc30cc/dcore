import { profileReviewState, type AdminProfileReviewItem, type ProfileReviewState } from '@app/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiRequest } from './api';
import type { Page } from './queries';

/**
 * The new-profile review queue (`/moderation/profiles`): accounts waiting
 * for a first review, sent back for changes, or refused, oldest first. A
 * decision names the state the admin saw (`from`).
 */

export const reviewStates: readonly ProfileReviewState[] = profileReviewState.names;

export function isReviewState(value: string | null): value is ProfileReviewState {
  return value !== null && (reviewStates as readonly string[]).includes(value);
}

export const reviewKeys = {
  queue: (state: ProfileReviewState) => ['profileReviews', state] as const,
};

const PAGE = 20;

export function useProfileReviews(state: ProfileReviewState) {
  return useInfiniteQuery({
    queryKey: reviewKeys.queue(state),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<AdminProfileReviewItem>) => last.nextCursor,
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ state, limit: String(PAGE) });
      if (pageParam) query.set('cursor', pageParam);
      return apiRequest<Page<AdminProfileReviewItem>>(`/v1/admin/moderation/profiles?${query.toString()}`, { signal });
    },
  });
}

export type ReviewDecision = 'approve' | 'needs-changes' | 'reject';

/** The decisions offered from a state: every one that moves the profile elsewhere. */
export function decisionsFrom(state: ProfileReviewState): ReviewDecision[] {
  if (state === 'needs_changes') return ['approve', 'reject'];
  if (state === 'rejected') return ['approve', 'needs-changes'];
  return ['approve', 'needs-changes', 'reject'];
}

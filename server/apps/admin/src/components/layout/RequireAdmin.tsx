import type { ReactNode } from 'react';
import { Navigate } from 'react-router';

/**
 * Guards the panel. Admin authentication does not exist yet, so a production
 * build lets nobody in and sends everyone to the sign-in page; a development
 * build shows the panel (with a banner) so the screens can be worked on.
 * Replace the check with the admin session once the API issues admin tokens.
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  if (!import.meta.env.DEV) return <Navigate to="/login" replace />;
  return children;
}

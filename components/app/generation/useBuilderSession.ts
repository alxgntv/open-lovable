'use client';

import { useCallback, useEffect, useState } from 'react';
import type { BuilderSessionUser } from '@/lib/auth/access-policy';

interface SessionResponse {
  success?: boolean;
  authenticated?: boolean;
  user?: BuilderSessionUser | null;
  error?: string;
}

export function useBuilderSession() {
  const [user, setUser] = useState<BuilderSessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<BuilderSessionUser | null> => {
    console.log('[useBuilderSession] Refreshing Code Market session');
    try {
      const response = await fetch('/api/auth/session', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => ({})) as SessionResponse;
      if (!response.ok) {
        console.error('[useBuilderSession] Session refresh failed', {
          status: response.status,
          error: payload.error,
        });
        setUser(null);
        setError(payload.error || 'Code Market sign-in is temporarily unavailable.');
        return null;
      }
      const nextUser = payload.authenticated && payload.user ? payload.user : null;
      setUser(nextUser);
      setError(null);
      console.log('[useBuilderSession] Session refreshed', {
        authenticated: Boolean(nextUser),
        userId: nextUser?.id,
      });
      return nextUser;
    } catch (refreshError) {
      console.error('[useBuilderSession] Session request failed', refreshError);
      setUser(null);
      setError('Code Market sign-in is temporarily unavailable.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    console.log('[useBuilderSession] Signing out');
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    setUser(null);
  }, []);

  return { user, loading, error, refresh, logout };
}

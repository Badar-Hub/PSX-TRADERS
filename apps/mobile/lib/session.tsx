import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { api, ApiError, clearTokens, readTokens, storeTokens } from './api';
import type { Account, AuthResponse, MeResponse, NextStep } from './types';

/**
 * Who is signed in, and what the app is allowed to show them.
 *
 * The important idea: *signed in* and *allowed in* are two different things.
 * Registration issues tokens immediately, so a brand-new account has a valid
 * session while being able to do nothing at all. `next` is what the UI routes
 * on — VERIFY_EMAIL, AWAITING_APPROVAL, READY or BLOCKED — and it comes from
 * the server, which re-reads the account on every request. The app never infers
 * it from whether a token exists, because a token says only that a password was
 * correct once.
 *
 * That also means the client cannot grant itself access by lying: every screen
 * past the gate calls an endpoint that checks the status server-side, so the
 * worst a tampered build achieves is a screen with no data in it.
 */

interface SessionValue {
  /** null once loading is done and nobody is signed in. */
  account: Account | null;
  next: NextStep | null;
  /** True until the stored token has been checked on launch. */
  loading: boolean;
  /** Set when a refresh of the account failed for a reason worth showing. */
  error: string | null;
  /**
   * When the outstanding verification code dies, ISO 8601, or null if this
   * install has not been told. It lives here rather than on the verify screen
   * because registration is where the server says it and the gate navigates
   * away from that screen immediately.
   */
  codeExpiresAt: string | null;

  signUp: (input: {
    email: string;
    password: string;
    name?: string;
  }) => Promise<{ codeExpiresAt: string | null; warning: string | null }>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  verify: (input: { email: string; code: string }) => Promise<void>;
  resend: (email: string) => Promise<{ codeExpiresAt: string | null }>;
  signOut: () => Promise<void>;
  /** Re-reads the account. The awaiting-approval screen polls this. */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** How often the pending screens ask whether anything has changed. */
const POLL_MS = 15_000;

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [account, setAccount] = useState<Account | null>(null);
  const [next, setNext] = useState<NextStep | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);

  // The refresh token, kept so sign-out can revoke it server-side rather than
  // just forgetting it locally. A token the server still honours is a token
  // somebody else can use.
  const refreshTokenRef = useRef<string | null>(null);

  const apply = useCallback((response: { user: Account; next: NextStep }) => {
    setAccount(response.user);
    setNext(response.next);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const me = await api<MeResponse>('/api/auth/me');
      apply(me);
    } catch (caught) {
      // A 401 here means the stored tokens are spent: the session is over, and
      // showing a signed-out app is the honest response. Anything else is most
      // likely the API being unreachable, which must not silently log the user
      // out — their tokens are fine and the next attempt may work.
      if (caught instanceof ApiError && caught.status === 401) {
        await clearTokens();
        refreshTokenRef.current = null;
        setAccount(null);
        setNext(null);
        setError(null);
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Could not reach the server');
    }
  }, [apply]);

  // On launch: if there is a stored token, find out what it is worth now.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { access, refresh: stored } = await readTokens();
      refreshTokenRef.current = stored;
      if (access === null && stored === null) {
        if (!cancelled) setLoading(false);
        return;
      }
      await refresh();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /*
   * While the account is waiting on a gate, poll.
   *
   * An admin approving someone happens elsewhere, so the app has no way to be
   * told. Polling every 15 seconds while that screen is open is enough for the
   * approval to feel immediate, and it stops the moment the status changes or
   * the app goes to the background — a phone in a pocket should not be calling
   * an API every quarter minute.
   */
  const waiting = next === 'AWAITING_APPROVAL' || next === 'VERIFY_EMAIL';
  useEffect(() => {
    if (!waiting) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => void refresh(), POLL_MS);
    };
    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    start();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        // Coming back to the app is the most likely moment for the answer to
        // have arrived, so ask straight away rather than waiting out the tick.
        void refresh();
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      subscription.remove();
    };
  }, [waiting, refresh]);

  const signUp = useCallback(
    async (input: { email: string; password: string; name?: string }) => {
      const response = await api<AuthResponse>('/api/auth/register', {
        method: 'POST',
        body: input,
        anonymous: true,
      });
      await storeTokens(response.accessToken, response.refreshToken);
      refreshTokenRef.current = response.refreshToken;
      apply(response);
      setCodeExpiresAt(response.codeExpiresAt ?? null);
      return {
        codeExpiresAt: response.codeExpiresAt ?? null,
        warning: response.warning?.message ?? null,
      };
    },
    [apply],
  );

  const signIn = useCallback(
    async (input: { email: string; password: string }) => {
      const response = await api<AuthResponse>('/api/auth/login', {
        method: 'POST',
        body: input,
        anonymous: true,
      });
      await storeTokens(response.accessToken, response.refreshToken);
      refreshTokenRef.current = response.refreshToken;
      apply(response);
    },
    [apply],
  );

  const verify = useCallback(
    async (input: { email: string; code: string }) => {
      await api<{ status: string; next: NextStep }>('/api/auth/verify-email', {
        method: 'POST',
        body: input,
        anonymous: true,
      });
      // The verify response carries the new status, but re-reading /auth/me
      // keeps one code path deciding what the app shows. The alternative is two
      // places that must agree about what PENDING_APPROVAL means.
      await refresh();
    },
    [refresh],
  );

  const resend = useCallback(async (email: string) => {
    const response = await api<{ codeExpiresAt?: string }>('/api/auth/resend-code', {
      method: 'POST',
      body: { email },
      anonymous: true,
    });
    // Absent when the address has no account awaiting verification — the
    // endpoint answers the same way either way on purpose, so as not to reveal
    // who is registered. The countdown is simply left as it was.
    if (response.codeExpiresAt !== undefined) setCodeExpiresAt(response.codeExpiresAt);
    return { codeExpiresAt: response.codeExpiresAt ?? null };
  }, []);

  const signOut = useCallback(async () => {
    const token = refreshTokenRef.current;
    if (token !== null) {
      try {
        await api<void>('/api/auth/logout', {
          method: 'POST',
          body: { refreshToken: token },
          anonymous: true,
        });
      } catch {
        // The local tokens are cleared regardless. A failed revocation leaves a
        // token alive on the server until it expires, which is worse than
        // nothing — but refusing to sign out because the network is down is
        // worse still, and the user would just delete the app.
      }
    }
    await clearTokens();
    refreshTokenRef.current = null;
    setAccount(null);
    setNext(null);
    setError(null);
    setCodeExpiresAt(null);
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      account,
      next,
      loading,
      error,
      codeExpiresAt,
      signUp,
      signIn,
      verify,
      resend,
      signOut,
      refresh,
    }),
    [
      account,
      next,
      loading,
      error,
      codeExpiresAt,
      signUp,
      signIn,
      verify,
      resend,
      signOut,
      refresh,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}

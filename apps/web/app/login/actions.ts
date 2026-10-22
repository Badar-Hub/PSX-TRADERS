'use server';

import { redirect } from 'next/navigation';
import { apiPublic } from '@/lib/api';
import { clearSessionCookies, setSessionCookies } from '@/lib/session';
import type { NextStep } from '@/lib/account';

/**
 * Sign-in and registration, as server actions.
 *
 * The credentials go from the form straight to the server and the tokens never
 * leave it: they are written into httpOnly cookies here. Nothing in the browser
 * ever holds either token, so a script injected into the page has nothing to
 * steal.
 */

export interface AuthState {
  error: string | null;
  /** For an outcome that is neither success nor failure: see register(). */
  notice?: string | null;
}

/**
 * The 202 register() can get back: the address was already registered and
 * still unverified, so a fresh code was sent. No password was checked, so no
 * session is opened — hence a shape of its own rather than an optional token.
 */
interface CodeResent {
  status: 'PENDING_VERIFICATION';
  message: string;
  codeExpiresAt?: string;
}

interface AuthSuccess {
  user: { id: string; email: string; name: string | null };
  accessToken: string;
  refreshToken: string;
  /** Where the account actually stands, which decides where to send them. */
  next?: NextStep;
  /** When the verification code dies, so the verify page can count down. */
  codeExpiresAt?: string;
  warning?: { code: string; message: string };
}

/**
 * Where an account at this step belongs.
 *
 * Both actions below end in a redirect, and neither decides for itself whether
 * the account is usable — the API says, and this translates the answer into a
 * path. A successful password check is not the same thing as access.
 */
function destinationFor(next: NextStep | undefined, codeExpiresAt?: string): string {
  switch (next) {
    case 'VERIFY_EMAIL':
      return codeExpiresAt === undefined
        ? '/verify'
        : `/verify?expires=${encodeURIComponent(codeExpiresAt)}`;
    case 'AWAITING_APPROVAL':
      return '/pending';
    case 'BLOCKED':
      return '/blocked';
    default:
      // READY, or an older API that does not report a step at all. The app
      // layout re-checks, so a wrong guess here costs one redirect.
      return '/';
  }
}

export async function signIn(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (email === '' || password === '') {
    return { error: 'Enter your email and password.' };
  }

  const result = await apiPublic<AuthSuccess>('/api/auth/login', { email, password });

  if (!result.ok) {
    // The API deliberately gives the same message for a wrong password and an
    // unknown email, so that a response cannot be used to enumerate accounts.
    // Passing it through unchanged preserves that.
    if (result.status === 429) {
      return { error: 'Too many attempts. Try again in a few minutes.' };
    }
    return { error: result.message };
  }

  await setSessionCookies(result.data);
  redirect(destinationFor(result.data.next));
}

export async function register(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '').trim();

  if (password.length < 10) {
    return { error: 'Password must be at least 10 characters.' };
  }

  const result = await apiPublic<AuthSuccess | CodeResent>('/api/auth/register', {
    email,
    password,
    ...(name !== '' ? { name } : {}),
  });

  if (!result.ok) {
    return {
      error:
        result.code === 'CONFLICT'
          ? 'An account with that email already exists.'
          : result.message,
    };
  }

  // The 202 described on CodeResent above. There is no session to open, so the
  // honest next step is to say a code is on its way and let them sign in.
  if (!('accessToken' in result.data)) {
    return {
      error: null,
      notice:
        'That email is already registered but not yet verified. A new code has been sent — ' +
        'sign in to enter it.',
    };
  }

  await setSessionCookies(result.data);
  redirect(destinationFor(result.data.next, result.data.codeExpiresAt));
}

export async function signOut(): Promise<void> {
  await clearSessionCookies();
  redirect('/login');
}

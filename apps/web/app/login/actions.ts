'use server';

import { redirect } from 'next/navigation';
import { apiPublic } from '@/lib/api';
import { clearSessionCookies, setSessionCookies } from '@/lib/session';

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
}

interface AuthSuccess {
  user: { id: string; email: string; name: string | null };
  accessToken: string;
  refreshToken: string;
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
  redirect('/');
}

export async function register(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '').trim();

  if (password.length < 10) {
    return { error: 'Password must be at least 10 characters.' };
  }

  const result = await apiPublic<AuthSuccess>('/api/auth/register', {
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

  await setSessionCookies(result.data);
  redirect('/');
}

export async function signOut(): Promise<void> {
  await clearSessionCookies();
  redirect('/login');
}

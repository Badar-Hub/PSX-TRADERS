'use server';

import { redirect } from 'next/navigation';
import { api, apiPublic, ApiError } from '@/lib/api';
import { setSessionCookies } from '@/lib/session';
import { loadAccount } from '@/lib/account';
import type { VerifyState } from './verifyState';
import type { ResetPasswordState } from './resetPasswordState';

interface ChangePasswordSuccess {
  accessToken: string;
  refreshToken: string;
}

/**
 * The verification steps, as server actions.
 *
 * The email address comes from the session rather than the form. Taking it from
 * a hidden field would let anyone spend another account's five guesses by
 * posting their address, which is a cheap way to lock a stranger out of their
 * own code.
 */

export async function submitCode(previous: VerifyState, formData: FormData): Promise<VerifyState> {
  const me = await loadAccount();
  if (me === null) redirect('/login');

  const code = String(formData.get('code') ?? '')
    .replace(/[\s-]/g, '')
    .trim();

  if (!/^\d{6}$/.test(code)) {
    return { ...previous, error: 'Enter the six digits from the email.', notice: null };
  }

  const result = await apiPublic<{ status: string; next: string }>('/api/auth/verify-email', {
    email: me.user.email,
    code,
  });

  if (!result.ok) {
    const { details } = result;
    const attemptsLeft =
      typeof details === 'object' && details !== null && 'attemptsLeft' in details
        ? Number((details as { attemptsLeft: unknown }).attemptsLeft)
        : null;
    return {
      ...previous,
      error: result.message,
      notice: null,
      attemptsLeft: Number.isFinite(attemptsLeft) ? attemptsLeft : null,
    };
  }

  redirect('/pending');
}

export async function resendCode(previous: VerifyState): Promise<VerifyState> {
  const me = await loadAccount();
  if (me === null) redirect('/login');

  const result = await apiPublic<{ message: string; codeExpiresAt?: string }>(
    '/api/auth/resend-code',
    { email: me.user.email },
  );

  if (!result.ok) {
    return {
      ...previous,
      error:
        result.status === 429
          ? 'A code was sent a moment ago. Wait a minute before asking for another.'
          : result.message,
      notice: null,
    };
  }

  return {
    error: null,
    notice: `A new code is on its way to ${me.user.email}. It lasts 10 minutes.`,
    attemptsLeft: null,
    codeExpiresAt: result.data.codeExpiresAt ?? null,
  };
}

/**
 * Replace a temporary password with one the account's owner chose.
 *
 * The API returns a fresh token pair, because changing the password revokes
 * every outstanding refresh token — including this session's. Writing the new
 * pair to the cookies is what stops a successful reset from logging the user
 * straight back out.
 */
export async function changePassword(
  previous: ResetPasswordState,
  formData: FormData,
): Promise<ResetPasswordState> {
  const me = await loadAccount();
  if (me === null) redirect('/login');

  const currentPassword = String(formData.get('currentPassword') ?? '');
  const newPassword = String(formData.get('newPassword') ?? '');
  const confirmPassword = String(formData.get('confirmPassword') ?? '');

  if (currentPassword === '' || newPassword === '') {
    return { ...previous, error: 'Fill in both passwords.' };
  }
  if (newPassword.length < 10) {
    return { ...previous, error: 'The new password must be at least 10 characters.' };
  }
  // Checked here rather than at the API, which has no business knowing the
  // form asked twice.
  if (newPassword !== confirmPassword) {
    return { ...previous, error: 'The two new passwords do not match.' };
  }

  let result: ChangePasswordSuccess;
  try {
    result = await api<ChangePasswordSuccess>('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
      noRedirect: true,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ...previous,
        error:
          error.status === 401
            ? 'That temporary password is not right. Check it and try again.'
            : error.message,
      };
    }
    throw error;
  }

  await setSessionCookies(result);
  redirect('/');
}

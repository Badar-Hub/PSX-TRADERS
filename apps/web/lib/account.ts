import { redirect } from 'next/navigation';
import { api, ApiError } from './api';

/**
 * The account, and which half of the app it may see.
 *
 * Signed in and allowed in are two different things. Registration issues
 * tokens immediately, so a brand-new account holds a valid session while being
 * able to do nothing at all: `/auth/me` is open to it, and every other endpoint
 * is not. `next` is what the pages route on, and it comes from the server,
 * which re-reads the account's status on every request — so a rejection takes
 * effect on the next page load rather than when the token expires.
 *
 * The redirects below are for the user's benefit, not security. The API is the
 * gate; the worst a bypass of these achieves is a page with no data in it.
 */

export type UserStatus =
  | 'PENDING_VERIFICATION'
  | 'PENDING_APPROVAL'
  | 'ACTIVE'
  | 'REJECTED'
  | 'SUSPENDED';

export type NextStep =
  | 'VERIFY_EMAIL'
  | 'AWAITING_APPROVAL'
  | 'RESET_PASSWORD'
  | 'READY'
  | 'BLOCKED';

export interface Account {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  role: 'MEMBER' | 'ADMIN';
  emailVerifiedAt: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
}

export interface Me {
  user: Account;
  next: NextStep;
}

/** The signed-in account, or null if nobody is signed in. */
export async function loadAccount(): Promise<Me | null> {
  try {
    return await api<Me>('/api/auth/me', { noRedirect: true });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

const STEP_PATHS: Record<Exclude<NextStep, 'READY'>, string> = {
  VERIFY_EMAIL: '/verify',
  AWAITING_APPROVAL: '/pending',
  RESET_PASSWORD: '/reset-password',
  BLOCKED: '/blocked',
};

/**
 * For the pages behind the gate. Returns the account, or redirects.
 *
 * Called from the app layout, so one check covers every page under it and
 * there is no page that forgot to ask.
 */
export async function requireActive(): Promise<Account> {
  const me = await loadAccount();
  if (me === null) redirect('/login');
  if (me.next !== 'READY') redirect(STEP_PATHS[me.next]);
  return me.user;
}

/**
 * For the onboarding pages themselves.
 *
 * Each one declares the step it serves; an account at a different step is sent
 * to its own, and an approved one is sent into the app. Without this, a user
 * could sit on "waiting for approval" after being approved, or on "enter your
 * code" after entering it.
 */
export async function requireStep(step: Exclude<NextStep, 'READY'>): Promise<Account> {
  const me = await loadAccount();
  if (me === null) redirect('/login');
  if (me.next === 'READY') redirect('/');
  if (me.next !== step) redirect(STEP_PATHS[me.next]);
  return me.user;
}

/** For the admin pages. A member is sent away, not shown a locked door. */
export async function requireAdmin(): Promise<Account> {
  const user = await requireActive();
  if (user.role !== 'ADMIN') redirect('/');
  return user;
}

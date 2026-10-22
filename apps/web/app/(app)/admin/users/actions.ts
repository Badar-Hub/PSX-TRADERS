'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import { requireAdmin } from '@/lib/account';
import type { DecisionState } from './decisionState';

/**
 * Approval decisions.
 *
 * `requireAdmin` is called here as well as in the page. A server action is a
 * POST endpoint whose URL anyone can find in the page source, so the page
 * having checked says nothing about who is calling this.
 */

type Decision = 'approve' | 'reject' | 'suspend';

const VERBS: Record<Decision, string> = {
  approve: 'approved',
  reject: 'rejected',
  suspend: 'suspended',
};

export async function decide(
  _previous: DecisionState,
  formData: FormData,
): Promise<DecisionState> {
  await requireAdmin();

  const id = String(formData.get('id') ?? '');
  const decision = String(formData.get('decision') ?? '') as Decision;
  const note = String(formData.get('note') ?? '').trim();
  const email = String(formData.get('email') ?? '');

  if (id === '' || !(decision in VERBS)) {
    return { error: 'That decision was not understood.', notice: null };
  }

  try {
    await api(`/api/admin/users/${id}/${decision}`, {
      method: 'POST',
      body: note !== '' ? { note } : {},
      noRedirect: true,
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message, notice: null };
    throw error;
  }

  // The queue is the whole point of the page, so it must not be served from a
  // cache that still lists the account just decided on.
  revalidatePath('/admin/users');

  return { error: null, notice: `${email} ${VERBS[decision]}.` };
}

'use client';

import { useActionState, useRef } from 'react';
import { decide } from './actions';
import { initialDecisionState } from './decisionState';
import type { UserStatus } from '@/lib/account';

/**
 * One account in the queue, with its decision buttons.
 *
 * The note is optional for an approval and worth filling in for a refusal: it
 * is what the rejected account is shown instead of a blank wall, and it is the
 * only record of why. The three buttons share one form so the note applies to
 * whichever is pressed.
 */
export function UserRow({
  id,
  email,
  name,
  status,
  role,
  joined,
  verified,
  approved,
  decisionNote,
  decidedBy,
}: {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  role: 'MEMBER' | 'ADMIN';
  joined: string;
  verified: string | null;
  approved: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
}) {
  const [state, action, pending] = useActionState(decide, initialDecisionState);

  /*
   * Which button was pressed, carried in a hidden field.
   *
   * The obvious way to write this is three submit buttons with
   * `name="decision"` and different values — and it does not work with
   * `useActionState`, which assembles its own FormData and leaves the
   * submitter's name and value out of it. The decision would arrive empty and
   * every press would be rejected as malformed.
   *
   * Set through a ref rather than React state because the value has to be in
   * the field by the time `requestSubmit` runs, and a state update would not
   * have been applied yet.
   */
  const decisionField = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const press = (decision: 'approve' | 'reject' | 'suspend') => () => {
    if (decisionField.current === null || form.current === null) return;
    decisionField.current.value = decision;
    form.current.requestSubmit();
  };

  const waiting = status === 'PENDING_APPROVAL';
  const active = status === 'ACTIVE';

  return (
    <div className="card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-slate-100">{email}</p>
          {name !== null && <p className="mt-0.5 text-xs text-slate-500">{name}</p>}
        </div>
        <div className="flex items-center gap-2">
          {role === 'ADMIN' && (
            <span className="rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide text-sky-300 ring-1 ring-sky-500/30">
              ADMIN
            </span>
          )}
          <span className="text-[11px] text-slate-500">{status.replace('_', ' ').toLowerCase()}</span>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Signed up</dt>
          <dd className="text-slate-300">{joined}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-slate-500">Email confirmed</dt>
          <dd className={verified === null ? 'text-amber-400' : 'text-slate-300'}>
            {verified ?? 'not yet'}
          </dd>
        </div>
        {approved !== null && (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Decided</dt>
            <dd className="text-slate-300">{approved}</dd>
          </div>
        )}
        {decidedBy !== null && (
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">By</dt>
            <dd className="text-slate-300">{decidedBy}</dd>
          </div>
        )}
      </dl>

      {decisionNote !== null && decisionNote !== '' && (
        <p className="mt-3 border-l-2 border-slate-700 pl-3 text-xs italic leading-relaxed text-slate-400">
          {decisionNote}
        </p>
      )}

      {state.error !== null && (
        <p className="mt-3 rounded-lg border border-rose-800/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
          {state.error}
        </p>
      )}
      {state.notice !== null && (
        <p className="mt-3 rounded-lg border border-emerald-800/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
          {state.notice}
        </p>
      )}

      {(waiting || active) && (
        <form ref={form} action={action} className="mt-4 space-y-2 border-t border-slate-800 pt-4">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="email" value={email} />
          <input ref={decisionField} type="hidden" name="decision" defaultValue="" />

          <label htmlFor={`note-${id}`} className="label block">
            Note
          </label>
          <input
            id={`note-${id}`}
            name="note"
            type="text"
            maxLength={500}
            className="input text-sm"
            placeholder={waiting ? 'Optional — shown to them if rejected' : 'Why suspend?'}
          />

          <div className="flex flex-wrap gap-2 pt-1">
            {waiting ? (
              <>
                <button
                  type="button"
                  onClick={press('approve')}
                  disabled={pending}
                  className="btn-primary text-sm"
                >
                  {pending ? 'Working…' : 'Approve'}
                </button>
                <button
                  type="button"
                  onClick={press('reject')}
                  disabled={pending}
                  className="btn-ghost text-sm text-rose-300"
                >
                  Reject
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={press('suspend')}
                disabled={pending}
                className="btn-ghost text-sm text-rose-300"
              >
                {pending ? 'Working…' : 'Suspend'}
              </button>
            )}
          </div>
        </form>
      )}

      {status === 'PENDING_VERIFICATION' && (
        <p className="mt-3 text-xs leading-relaxed text-slate-600">
          Cannot be approved until the email address is confirmed. The API refuses it, because
          approving an unconfirmed address would open the account to whoever typed the email rather
          than whoever owns it.
        </p>
      )}
    </div>
  );
}

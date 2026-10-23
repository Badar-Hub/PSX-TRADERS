'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { changePassword } from '../actions';
import { initialResetPasswordState } from '../resetPasswordState';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary mt-5 w-full" disabled={pending}>
      {pending ? 'Saving…' : 'Set new password'}
    </button>
  );
}

export function ResetPasswordForm() {
  const [state, action] = useActionState(changePassword, initialResetPasswordState);

  return (
    <form action={action} className="mt-5">
      <label className="label" htmlFor="currentPassword">
        Temporary password
      </label>
      <input
        id="currentPassword"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
        className="input mt-1 w-full"
      />

      <label className="label mt-4 block" htmlFor="newPassword">
        New password
      </label>
      <input
        id="newPassword"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        minLength={10}
        required
        className="input mt-1 w-full"
      />
      <p className="mt-1 text-xs text-slate-600">
        At least 10 characters. Length is the only rule — a long phrase beats a short one with
        symbols in it.
      </p>

      <label className="label mt-4 block" htmlFor="confirmPassword">
        New password again
      </label>
      <input
        id="confirmPassword"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        minLength={10}
        required
        className="input mt-1 w-full"
      />

      {state.error !== null ? (
        <p role="alert" className="mt-4 text-sm text-rose-400">
          {state.error}
        </p>
      ) : null}

      <Submit />
    </form>
  );
}

'use client';

import { useActionState, useEffect, useState } from 'react';
import { resendCode, submitCode } from '../actions';
import { initialVerifyState } from '../verifyState';

/** The API's own resend cooldown, so the button can show it rather than letting
 * the user press into a 429. */
const RESEND_COOLDOWN_SECONDS = 60;

function countdown(msRemaining: number): string {
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function VerifyForm({ initialExpiresAt }: { initialExpiresAt: string | null }) {
  const [state, action, pending] = useActionState(submitCode, {
    ...initialVerifyState,
    codeExpiresAt: initialExpiresAt,
  });
  const [resendState, resendAction, resending] = useActionState(resendCode, initialVerifyState);
  const [now, setNow] = useState(() => Date.now());
  const [cooldown, setCooldown] = useState(0);

  // A resend supersedes whatever expiry the page was rendered with.
  const expiresAt = resendState.codeExpiresAt ?? state.codeExpiresAt ?? initialExpiresAt;

  /*
   * A ten-minute life is only a real constraint if the user can see it running
   * out — otherwise a code that died while they went to find their phone just
   * looks like the form rejecting the right number.
   */
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (resendState.notice === null) return;
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }, [resendState.notice]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const remaining = expiresAt === null ? null : Date.parse(expiresAt) - now;
  const expired = remaining !== null && !Number.isNaN(remaining) && remaining <= 0;

  const error = state.error ?? resendState.error;
  const notice = resendState.notice;

  return (
    <>
      <form action={action} className="mt-5 space-y-4">
        <div>
          <label htmlFor="code" className="label mb-1.5 block">
            Verification code
          </label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={7}
            placeholder="123456"
            // Spaces and dashes are stripped before sending, because people
            // paste "123 456" straight out of the email.
            className="input text-center text-2xl tracking-[0.5em]"
          />
          {state.attemptsLeft !== null && state.attemptsLeft > 0 && (
            <p className="mt-1.5 text-xs text-amber-400">
              {state.attemptsLeft} attempt{state.attemptsLeft === 1 ? '' : 's'} left on this code.
            </p>
          )}
        </div>

        {error !== null && (
          <p className="rounded-lg border border-rose-800/40 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
            {error}
          </p>
        )}
        {notice !== null && (
          <p className="rounded-lg border border-sky-800/40 bg-sky-950/30 px-3 py-2 text-sm text-sky-300">
            {notice}
          </p>
        )}
        {expired && (
          <p className="rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-sm text-amber-300">
            That code has expired. Send yourself a new one.
          </p>
        )}

        <button type="submit" disabled={pending} className="btn-primary w-full">
          {pending ? 'Checking…' : 'Verify'}
        </button>
      </form>

      {remaining !== null && !Number.isNaN(remaining) && !expired && (
        <p className="mt-3 text-center text-xs text-slate-500">
          Expires in {countdown(remaining)}
        </p>
      )}

      <form action={resendAction} className="mt-3">
        <button
          type="submit"
          disabled={resending || cooldown > 0}
          className="btn-ghost w-full text-sm"
        >
          {cooldown > 0
            ? `Send a new code in ${cooldown}s`
            : resending
              ? 'Sending…'
              : 'Send a new code'}
        </button>
      </form>
    </>
  );
}

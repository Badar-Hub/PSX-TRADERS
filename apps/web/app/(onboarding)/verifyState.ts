/**
 * The verify form's state shape, in a module of its own.
 *
 * Not in `actions.ts`, because that file is `'use server'` — and every export
 * of a server-action module is turned into an action reference when a client
 * component imports it, whatever it was declared as. A plain object exported
 * from there arrives in the browser as a function, so `state.notice` reads
 * `undefined` rather than `null`, and any `!== null` check silently takes the
 * wrong branch. That is how the resend button started its cooldown on page
 * load, before anything had been resent.
 *
 * Types are erased, so importing those from a server module is fine; values
 * are not, so they live here.
 */

export interface VerifyState {
  error: string | null;
  notice: string | null;
  /** Guesses left on the current code, when the API said. */
  attemptsLeft: number | null;
  /** When the outstanding code dies, ISO 8601, for the countdown. */
  codeExpiresAt: string | null;
}

export const initialVerifyState: VerifyState = {
  error: null,
  notice: null,
  attemptsLeft: null,
  codeExpiresAt: null,
};

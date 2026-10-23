/**
 * The reset form's state shape, in a module of its own.
 *
 * Same reason as verifyState.ts: `actions.ts` is `'use server'`, and every
 * export of a server-action module becomes an action reference once a client
 * component imports it — a plain object arrives in the browser as a function.
 * Types are erased so they can come from there; values cannot.
 */

export interface ResetPasswordState {
  error: string | null;
}

export const initialResetPasswordState: ResetPasswordState = {
  error: null,
};

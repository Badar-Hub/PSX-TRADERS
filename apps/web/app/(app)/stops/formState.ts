/**
 * The stop forms' state shape.
 *
 * In its own module, not in `actions.ts`, because a `'use server'` module's
 * exports all become action references once a client component imports them —
 * so a plain object exported from there is not the object the component thinks
 * it got. See `app/(onboarding)/verifyState.ts` for what that cost last time.
 */

export interface StopFormState {
  error: string | null;
  notice: string | null;
  fieldErrors?: Record<string, string>;
}

export const initialStopState: StopFormState = { error: null, notice: null };

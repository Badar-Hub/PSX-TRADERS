/**
 * The decision form's state shape.
 *
 * In its own module rather than in `actions.ts`, for the reason spelled out in
 * `app/(onboarding)/verifyState.ts`: a `'use server'` module's exports all
 * become action references in the browser, so a plain object exported from
 * there is not the object the client component thinks it imported.
 */

export interface DecisionState {
  error: string | null;
  notice: string | null;
}

export const initialDecisionState: DecisionState = { error: null, notice: null };

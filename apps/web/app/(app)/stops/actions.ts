'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import type { StopBacktest, StopEvaluation, StopRule, StopSuggestion } from '@/lib/types';
import type { StopFormState } from './formState';

/**
 * Arming, adjusting and cancelling stop rules.
 *
 * Prices go to the API as strings, exactly as typed, for the same reason trades
 * do: a JSON number is a float by the time it is parsed, and rounding it back
 * to paisa is guesswork. The string parses to integer paisa exactly.
 *
 * Nothing here sells anything. A rule is an alert, and a trigger writes an
 * event the user acts on with their broker — so these actions create and
 * cancel watchers, never trades.
 */

export async function createStop(
  _previous: StopFormState,
  formData: FormData,
): Promise<StopFormState> {
  const portfolioId = String(formData.get('portfolioId') ?? '');
  const symbol = String(formData.get('symbol') ?? '')
    .trim()
    .toUpperCase();
  const type = String(formData.get('type') ?? 'STOP_LOSS');
  const triggerOn = String(formData.get('triggerOn') ?? 'CLOSE');
  const thresholdPrice = String(formData.get('thresholdPrice') ?? '').trim();
  const trailPercent = String(formData.get('trailPercent') ?? '').trim();
  const quantityRaw = String(formData.get('quantity') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();
  const expiresOn = String(formData.get('expiresOn') ?? '').trim();

  const fieldErrors: Record<string, string> = {};

  if (!/^[A-Z0-9-]{1,20}$/.test(symbol)) fieldErrors.symbol = 'Enter a PSX ticker, e.g. HBL';

  const trailing = type === 'TRAILING_STOP';

  if (trailing) {
    // Entered as a percentage because that is how people say it; converted to
    // basis points here so the API never receives a fraction to round.
    if (!/^\d+(\.\d{1,2})?$/.test(trailPercent)) {
      fieldErrors.trailPercent = 'A percentage like 10 or 7.5';
    } else {
      const bps = Math.round(Number(trailPercent) * 100);
      if (bps < 100 || bps > 5_000) {
        fieldErrors.trailPercent =
          'Between 1% and 50%. Below 1% the stop sits inside the daily noise; above 50% it is ' +
          'not protecting anything.';
      }
    }
  } else if (!/^\d+(\.\d{1,2})?$/.test(thresholdPrice) || Number(thresholdPrice) <= 0) {
    fieldErrors.thresholdPrice = 'A price like 170.19, at most 2 decimals';
  }

  const quantity = quantityRaw === '' ? undefined : Number(quantityRaw);
  if (quantity !== undefined && (!Number.isInteger(quantity) || quantity <= 0)) {
    fieldErrors.quantity = 'Whole number of shares, or leave blank';
  }

  if (expiresOn !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) {
    fieldErrors.expiresOn = 'Pick a date, or leave blank';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Check the highlighted fields.', notice: null, fieldErrors };
  }

  try {
    await api<{ rule: StopRule }>(`/api/portfolios/${portfolioId}/stops`, {
      method: 'POST',
      noRedirect: true,
      body: {
        symbol,
        type,
        triggerOn,
        ...(trailing
          ? { trailBps: Math.round(Number(trailPercent) * 100) }
          : { thresholdPrice }),
        ...(quantity !== undefined ? { quantity } : {}),
        ...(note !== '' ? { note } : {}),
        ...(expiresOn !== '' ? { expiresOn } : {}),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: error.message, notice: null };
    }
    throw error;
  }

  revalidatePath('/stops');
  return {
    error: null,
    notice: `Watching ${symbol}. It is checked against each new close, and you will see it here.`,
  };
}

export async function cancelStop(
  _previous: StopFormState,
  formData: FormData,
): Promise<StopFormState> {
  const ruleId = String(formData.get('ruleId') ?? '');
  const symbol = String(formData.get('symbol') ?? '');

  try {
    await api<{ rule: StopRule }>(`/api/stops/${ruleId}/cancel`, {
      method: 'POST',
      noRedirect: true,
      body: {},
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message, notice: null };
    throw error;
  }

  revalidatePath('/stops');
  return { error: null, notice: `Stopped watching ${symbol}. The rule is kept as history.` };
}

export async function acknowledgeStopEvent(
  _previous: StopFormState,
  formData: FormData,
): Promise<StopFormState> {
  const eventId = String(formData.get('eventId') ?? '');

  try {
    await api(`/api/stop-events/${eventId}/acknowledge`, {
      method: 'POST',
      noRedirect: true,
      body: {},
    });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message, notice: null };
    throw error;
  }

  revalidatePath('/stops');
  return { error: null, notice: 'Marked as seen.' };
}

/**
 * Checks the armed rules against the stored history now.
 *
 * The nightly job does this anyway, but a rule armed this afternoon would
 * otherwise sit untested until tomorrow — and the user has no way to tell
 * "nothing has happened" from "nothing has been checked". It is idempotent, so
 * pressing it twice is harmless.
 */
export async function evaluateStops(
  _previous: StopFormState,
  formData: FormData,
): Promise<StopFormState> {
  const portfolioId = String(formData.get('portfolioId') ?? '');

  let summary: StopEvaluation;
  try {
    const response = await api<{ summary: StopEvaluation }>(
      `/api/portfolios/${portfolioId}/stops/evaluate`,
      { method: 'POST', noRedirect: true, body: {} },
    );
    summary = response.summary;
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message, notice: null };
    throw error;
  }

  revalidatePath('/stops');

  const parts: string[] = [`${summary.rulesChecked} rule${summary.rulesChecked === 1 ? '' : 's'} checked`];
  if (summary.triggered > 0) parts.push(`${summary.triggered} triggered`);
  if (summary.moved > 0) parts.push(`${summary.moved} trailed up`);
  if (summary.expired > 0) parts.push(`${summary.expired} expired`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} could not be evaluated`);

  return {
    error: null,
    notice:
      summary.triggered === 0 && summary.moved === 0
        ? `${parts.join(', ')}. Nothing has been breached.`
        : `${parts.join(', ')}.`,
  };
}

export interface TrailAdvice {
  suggestion: StopSuggestion | null;
  backtest: StopBacktest | null;
  error: string | null;
}

/**
 * What a trail is worth on this symbol, before arming it.
 *
 * Called directly from the client component as an RPC rather than through a
 * form, because the advice panel sits inside the arming form and a form cannot
 * nest inside another. The browser has no API token — every call goes through
 * the server, which holds the httpOnly cookie — so this has to be an action
 * either way.
 *
 * Two answers in one call: a width scaled to the stock's own range, and what
 * the width the user actually typed would have done over the stored history.
 * Separately they are a number and a chart; together they are an argument.
 */
export async function getTrailAdvice(symbol: string, trailPercent: string): Promise<TrailAdvice> {
  const ticker = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,20}$/.test(ticker)) {
    return { suggestion: null, backtest: null, error: 'Enter a PSX ticker first.' };
  }

  const bps = Math.round(Number(trailPercent) * 100);
  const usable = Number.isFinite(bps) && bps >= 100 && bps <= 5_000;

  try {
    const [suggestion, backtest] = await Promise.all([
      api<{ suggestion: StopSuggestion }>(`/api/securities/${ticker}/stop-suggestion`, {
        noRedirect: true,
      }).then((response) => response.suggestion),
      usable
        ? api<{ backtest: StopBacktest }>(
            `/api/securities/${ticker}/stop-backtest?trailBps=${bps}`,
            { noRedirect: true },
          ).then((response) => response.backtest)
        : Promise.resolve(null),
    ]);

    return { suggestion, backtest, error: null };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        suggestion: null,
        backtest: null,
        error:
          error.status === 404
            ? `No stored history for ${ticker}. Run the ingest, or pick the level yourself.`
            : error.message,
      };
    }
    throw error;
  }
}

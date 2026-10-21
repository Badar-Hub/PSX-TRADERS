'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { Trade } from '@/lib/types';

/**
 * Recording and correcting trades.
 *
 * Prices go to the API as strings, exactly as typed. A JSON number is already a
 * float by the time it is parsed — 170.19 arrives as 170.18999999999999 — and
 * rounding it back is guesswork. The string parses to integer paisa exactly, so
 * the amount stored is the amount entered.
 */

export interface TradeFormState {
  error: string | null;
  fieldErrors?: Record<string, string>;
}

export async function createTrade(
  _previous: TradeFormState,
  formData: FormData,
): Promise<TradeFormState> {
  const portfolioId = String(formData.get('portfolioId') ?? '');
  const symbol = String(formData.get('symbol') ?? '').trim().toUpperCase();
  const side = String(formData.get('side') ?? 'BUY');
  const tradedOn = String(formData.get('tradedOn') ?? '');
  const quantityRaw = String(formData.get('quantity') ?? '');
  const unitPrice = String(formData.get('unitPrice') ?? '').trim();
  const brokerage = String(formData.get('brokerage') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();

  const fieldErrors: Record<string, string> = {};

  if (!/^[A-Z0-9-]{1,20}$/.test(symbol)) fieldErrors.symbol = 'Enter a PSX ticker, e.g. HBL';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradedOn)) fieldErrors.tradedOn = 'Pick a date';

  const quantity = Number(quantityRaw);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    fieldErrors.quantity = 'Whole number of shares';
  }

  // Validated here as well as server-side so the user is told which field is
  // wrong rather than getting a generic rejection back from the API.
  if (!/^\d+(\.\d{1,2})?$/.test(unitPrice) || Number(unitPrice) <= 0) {
    fieldErrors.unitPrice = 'A price like 170.19, at most 2 decimals';
  }
  if (brokerage !== '' && !/^\d+(\.\d{1,2})?$/.test(brokerage)) {
    fieldErrors.brokerage = 'An amount like 22.50, or leave blank';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { error: 'Check the highlighted fields.', fieldErrors };
  }

  try {
    await api<{ trade: Trade }>(`/api/portfolios/${portfolioId}/trades`, {
      method: 'POST',
      noRedirect: true,
      body: {
        symbol,
        side,
        tradedOn,
        quantity,
        unitPrice,
        // Omitted entirely rather than sent as zero: the API computes charges
        // from the account's schedule when they are absent, and sending zero
        // would assert the trade genuinely cost nothing.
        ...(brokerage !== '' ? { charges: { brokerage } } : {}),
        ...(note !== '' ? { note } : {}),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      // The ledger refusing a short sale is the most likely rejection, and its
      // message already names the symbol and the shortfall.
      if (error.code === 'INSUFFICIENT_SHARES') return { error: error.message };
      if (error.status === 401) redirect('/login?expired=1');
      return { error: error.message };
    }
    return { error: 'Could not record the trade.' };
  }

  revalidatePath('/');
  revalidatePath('/trades');
  revalidatePath('/reports');
  redirect(`/trades?portfolio=${portfolioId}`);
}

export async function reverseTrade(formData: FormData): Promise<void> {
  const tradeId = String(formData.get('tradeId') ?? '');
  const portfolioId = String(formData.get('portfolioId') ?? '');

  await api(`/api/trades/${tradeId}/reverse`, { method: 'POST', body: {} });

  revalidatePath('/');
  revalidatePath('/trades');
  revalidatePath('/reports');
  redirect(`/trades?portfolio=${portfolioId}`);
}

'use client';

import { useActionState, useState } from 'react';
import { createTrade, type TradeFormState } from '../actions';

const initial: TradeFormState = { error: null };

export function TradeForm({
  portfolioId,
  defaultSymbol,
  hasAccount,
}: {
  portfolioId: string;
  defaultSymbol: string;
  hasAccount: boolean;
}) {
  const [state, action, pending] = useActionState(createTrade, initial);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');

  const today = new Date().toISOString().slice(0, 10);
  const fieldError = (name: string) => state.fieldErrors?.[name];

  return (
    <form action={action} className="card space-y-4">
      <input type="hidden" name="portfolioId" value={portfolioId} />

      <div className="grid grid-cols-2 gap-2">
        {(['BUY', 'SELL'] as const).map((option) => (
          <label
            key={option}
            className={`cursor-pointer rounded-lg border px-4 py-2.5 text-center text-sm font-medium transition-colors ${
              side === option
                ? option === 'BUY'
                  ? 'border-emerald-600 bg-emerald-600/10 text-emerald-400'
                  : 'border-rose-600 bg-rose-600/10 text-rose-400'
                : 'border-slate-700 text-slate-400 hover:bg-slate-800/50'
            }`}
          >
            <input
              type="radio"
              name="side"
              value={option}
              checked={side === option}
              onChange={() => setSide(option)}
              className="sr-only"
            />
            {option === 'BUY' ? 'Buy' : 'Sell'}
          </label>
        ))}
      </div>

      <Field label="Symbol" name="symbol" error={fieldError('symbol')}>
        <input
          id="symbol"
          name="symbol"
          defaultValue={defaultSymbol}
          required
          placeholder="HBL"
          autoCapitalize="characters"
          className="input uppercase"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" name="tradedOn" error={fieldError('tradedOn')}>
          <input
            id="tradedOn"
            name="tradedOn"
            type="date"
            required
            defaultValue={today}
            max={today}
            className="input"
          />
        </Field>

        <Field label="Shares" name="quantity" error={fieldError('quantity')}>
          <input
            id="quantity"
            name="quantity"
            type="number"
            min={1}
            step={1}
            required
            placeholder="100"
            className="input numeric"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Price per share"
          name="unitPrice"
          error={fieldError('unitPrice')}
          hint="Rupees, at most 2 decimals"
        >
          <input
            id="unitPrice"
            name="unitPrice"
            inputMode="decimal"
            required
            placeholder="170.19"
            className="input numeric"
          />
        </Field>

        <Field
          label="Brokerage"
          name="brokerage"
          error={fieldError('brokerage')}
          hint={
            hasAccount
              ? 'Leave blank to compute from your account'
              : 'Optional — no brokerage account attached'
          }
        >
          <input
            id="brokerage"
            name="brokerage"
            inputMode="decimal"
            placeholder="22.50"
            className="input numeric"
          />
        </Field>
      </div>

      <Field label="Note" name="note" hint="Optional. Your thesis, or the contract note number.">
        <input id="note" name="note" className="input" maxLength={2000} />
      </Field>

      {/*
        Worth stating plainly: the figures from the contract note win. Matching
        the broker's own numbers matters more than internal consistency with a
        computed schedule.
      */}
      <p className="text-xs leading-relaxed text-slate-600">
        Charges you enter are used exactly as given, so the portfolio reconciles against
        your contract note. Left blank, they are computed from the account&apos;s rates.
      </p>

      {state.error !== null && (
        <p className="rounded-lg border border-rose-800/40 bg-rose-950/30 px-3 py-2 text-sm text-rose-300">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={pending} className="btn-primary w-full">
        {pending ? 'Recording…' : `Record ${side === 'BUY' ? 'purchase' : 'sale'}`}
      </button>
    </form>
  );
}

function Field({
  label,
  name,
  error,
  hint,
  children,
}: {
  label: string;
  name: string;
  error?: string | undefined;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={name} className="label mb-1.5 block">
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p className="mt-1 text-xs text-rose-400">{error}</p>
      ) : (
        hint !== undefined && <p className="mt-1 text-xs text-slate-600">{hint}</p>
      )}
    </div>
  );
}

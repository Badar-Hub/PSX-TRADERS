'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Jump to any symbol's prediction.
 *
 * A plain navigation rather than a typeahead against the API. With around 500
 * listings and tickers the user already knows, a search-as-you-type would be
 * more machinery for no gain, and it would need either the symbol list on the
 * client or a request per keystroke.
 */
export function SymbolSearch() {
  const router = useRouter();
  const [symbol, setSymbol] = useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const cleaned = symbol.trim().toUpperCase();
        if (cleaned !== '') router.push(`/signals/${cleaned}`);
      }}
      className="card flex flex-wrap items-end gap-3"
    >
      <div className="min-w-48 flex-1">
        <label htmlFor="symbol-search" className="label mb-1.5 block">
          Look up a prediction
        </label>
        <input
          id="symbol-search"
          value={symbol}
          onChange={(event) => setSymbol(event.target.value)}
          placeholder="HBL, OGDC, PRL…"
          className="input uppercase"
          autoCapitalize="characters"
        />
      </div>
      <button type="submit" className="btn-ghost">
        Open
      </button>
    </form>
  );
}

'use client';

import { useRouter } from 'next/navigation';

/** Pakistan's tax year runs 1 July to 30 June. */
function taxYear(offset = 0): { from: string; to: string; label: string } {
  const now = new Date();
  const startYear = (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1) + offset;
  return {
    from: `${startYear}-07-01`,
    to: `${startYear + 1}-06-30`,
    label: `FY ${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`,
  };
}

export function PeriodPicker({
  portfolioId,
  from,
  to,
}: {
  portfolioId: string;
  from: string;
  to: string;
}) {
  const router = useRouter();
  const current = taxYear(0);
  const previous = taxYear(-1);
  const now = new Date().toISOString().slice(0, 10);

  const options = [
    { ...current, key: 'current' },
    { ...previous, key: 'previous' },
    { from: `${now.slice(0, 4)}-01-01`, to: now, label: 'Calendar year', key: 'calendar' },
    { from: now.slice(0, 7) + '-01', to: now, label: 'This month', key: 'month' },
  ];

  const activeKey =
    options.find((option) => option.from === from && option.to === to)?.key ?? 'custom';

  return (
    <select
      aria-label="Period"
      value={activeKey}
      onChange={(event) => {
        const option = options.find((candidate) => candidate.key === event.target.value);
        if (option === undefined) return;
        router.push(
          `/reports?portfolio=${portfolioId}&from=${option.from}&to=${option.to}`,
        );
      }}
      className="input w-auto py-1.5 text-sm"
    >
      {options.map((option) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
      {activeKey === 'custom' && <option value="custom">Custom</option>}
    </select>
  );
}

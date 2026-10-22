'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Asks the server to re-render this page every so often.
 *
 * `router.refresh()` re-runs the server component, which re-runs
 * `requireStep` — and that redirects into the app the moment the status
 * changes. So the redirect logic stays in one place on the server, and this
 * component only decides when to ask; it never inspects the account itself.
 *
 * It stops while the tab is hidden. A page left open in a background tab for a
 * week should not keep calling the API every fifteen seconds.
 */
const POLL_MS = 15_000;

export function PendingPoller() {
  const router = useRouter();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => router.refresh(), POLL_MS);
    };
    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        // Returning to the tab is the likeliest moment for the answer to have
        // arrived, so ask at once rather than waiting out the tick.
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return (
    <button
      type="button"
      onClick={() => {
        setChecking(true);
        router.refresh();
        // No completion callback to hook into, so the label is restored on a
        // timer. It exists to acknowledge the press, not to report a result —
        // a successful check navigates away on its own.
        setTimeout(() => setChecking(false), 1200);
      }}
      className="btn-ghost mt-5 w-full text-sm"
    >
      {checking ? 'Checking…' : 'Check now'}
    </button>
  );
}

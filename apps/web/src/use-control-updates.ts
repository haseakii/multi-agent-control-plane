import { useEffect, useState } from 'react';

/** SSE invalidates the durable snapshot; reconciliation covers non-audited probe/readiness state. */
export function useControlUpdates(projectId: string | undefined, refresh: () => Promise<void>) {
  const [live, setLive] = useState(false);
  useEffect(() => {
    let active = true,
      connected = false,
      inFlight = false,
      again = false;
    let timer: number | undefined, debounce: number | undefined;
    setLive(false);
    const reload = async () => {
      if (!active) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      try {
        await refresh();
      } finally {
        inFlight = false;
        if (active && again) {
          again = false;
          void reload();
        }
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(
        async () => {
          await reload();
          if (active) schedule();
        },
        connected ? 15_000 : 2_000,
      );
    };
    const invalidate = () => {
      if (!active || debounce !== undefined) return;
      debounce = window.setTimeout(() => {
        debounce = undefined;
        void reload();
      }, 80);
    };
    void reload();
    schedule();
    const source =
      projectId && typeof EventSource !== 'undefined'
        ? new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events/stream`)
        : undefined;
    const ready = () => {
      if (!active) return;
      connected = true;
      setLive(true);
      invalidate();
      schedule();
    };
    const fallback = () => {
      if (!active) return;
      const wasConnected = connected;
      connected = false;
      setLive(false);
      if (wasConnected) schedule();
    };
    source?.addEventListener('ready', ready);
    source?.addEventListener('control-event', invalidate);
    source?.addEventListener('reset', invalidate);
    source?.addEventListener('unavailable', fallback);
    source?.addEventListener('error', fallback);
    return () => {
      active = false;
      source?.close();
      window.clearTimeout(timer);
      window.clearTimeout(debounce);
    };
  }, [projectId, refresh]);
  return live;
}

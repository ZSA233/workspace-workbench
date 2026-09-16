import { useCallback, useRef } from 'react';
import { boundedRefresh } from './observation';
/** Keep refresh control separate from rendering, with one owned operation per panel. */
export function useObservationRefresh(requests: () => Promise<unknown>[], timeoutMs: number, setBusy: (busy: boolean) => void) {
  const flight = useRef<Promise<void> | null>(null);
  const current = useRef(requests); current.current = requests;
  return useCallback((): Promise<void> => {
    if (flight.current) return flight.current;
    setBusy(true);
    const pending = Promise.resolve().then(() => Promise.allSettled(current.current().map(request => boundedRefresh(request, timeoutMs))))
      .then(() => undefined).finally(() => { flight.current = null; setBusy(false); });
    flight.current = pending;
    return pending;
  }, [timeoutMs, setBusy]);
}

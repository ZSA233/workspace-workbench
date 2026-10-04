import { useLayoutEffect, useRef } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';

/** Keep only a cache address, never a second copy of query results. */
export type DisplayAddress = { family: string; key: QueryKey };
export function previousDisplay<T>(address: DisplayAddress | undefined, family: string, read: (key: QueryKey) => T | undefined): T | undefined {
  return address?.family === family ? read(address.key) : undefined;
}
export function useQueryContinuity<T>(family: string, key: QueryKey, current: T | undefined, select: (data: unknown) => T | undefined) {
  const client = useQueryClient();
  const address = useRef<DisplayAddress | undefined>(undefined);
  const previous = previousDisplay(address.current, family, saved => select(client.getQueryData(saved)));
  useLayoutEffect(() => {
    if (current !== undefined) address.current = { family, key };
    else if (address.current?.family !== family) address.current = undefined;
  });
  return { displayed: current ?? previous, retained: current === undefined && previous !== undefined };
}

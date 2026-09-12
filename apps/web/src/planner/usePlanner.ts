import { useEffect } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { CLIENT_POLL_MS, type ListMessagesResponse, type SnapshotResponse } from '@trip/contracts';
import { useAdapter } from '../adapter/context';

/**
 * Query keys carry the mode, so demo and live results can never be served to
 * one another out of the same cache even before the cache is cleared.
 */
export function plannerKeys(mode: string, tripId: string) {
  return {
    snapshot: ['snapshot', mode, tripId] as const,
    messages: ['messages', mode, tripId] as const,
  };
}

export function useSnapshot(tripId: string): UseQueryResult<SnapshotResponse> {
  const adapter = useAdapter();
  return useQuery({
    queryKey: plannerKeys(adapter.mode, tripId).snapshot,
    queryFn: () => adapter.snapshot(tripId),
    // While a batch is in flight the plan changes without us asking, and a
    // stopped worker must not be able to look healthy indefinitely.
    refetchInterval: (query) => {
      const state = query.state.data?.processing.state;
      return state === 'queued' || state === 'running' ? 1000 : CLIENT_POLL_MS;
    },
  });
}

export function useMessages(tripId: string): UseQueryResult<ListMessagesResponse> {
  const adapter = useAdapter();
  return useQuery({
    queryKey: plannerKeys(adapter.mode, tripId).messages,
    queryFn: () => adapter.messages(tripId),
  });
}

/** Refetches both reads. Every mutation ends here rather than patching caches. */
export function useRefreshPlanner(tripId: string): () => Promise<void> {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const keys = plannerKeys(adapter.mode, tripId);
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.snapshot }),
      queryClient.invalidateQueries({ queryKey: keys.messages }),
    ]);
  };
}

/**
 * Demo state changes locally rather than over the wire, so its store is the
 * invalidation signal that realtime provides in live mode.
 */
export function useDemoInvalidation(tripId: string): void {
  const adapter = useAdapter();
  const refresh = useRefreshPlanner(tripId);
  const demo = adapter.demo;
  useEffect(() => {
    if (demo === null) return;
    return demo.subscribe(() => void refresh());
    // `refresh` is rebuilt each render; the subscription only needs the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);
}

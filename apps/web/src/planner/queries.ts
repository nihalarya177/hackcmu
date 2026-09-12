import { useEffect } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  CLIENT_POLL_MS,
  isNewerVersion,
  type ListMessagesResponse,
  type SnapshotResponse,
} from '@trip/contracts';
import { api, ApiRequestError } from '../lib/api';
import { subscribeToTrip } from '../lib/realtime';

/**
 * A trip that answers 404 is one this identity is not a member of, and that is
 * permanent for this browser: retrying and polling can never turn it into a
 * yes. Both reads stop rather than hammering the API every five seconds.
 */
function retryUnlessUnreachable(failureCount: number, error: Error): boolean {
  const unreachable = error instanceof ApiRequestError && error.code === 'NOT_FOUND';
  return !unreachable && failureCount < 1;
}

function pollUnlessFailed(
  status: 'error' | 'pending' | 'success',
  interval: number,
): number | false {
  return status === 'error' ? false : interval;
}

export const snapshotKey = (tripId: string) => ['snapshot', tripId] as const;
export const messagesKey = (tripId: string) => ['messages', tripId] as const;

export function useSnapshot(tripId: string): UseQueryResult<SnapshotResponse> {
  return useQuery({
    queryKey: snapshotKey(tripId),
    queryFn: () => api.snapshot(tripId),
    retry: retryUnlessUnreachable,
    // Realtime can drop; polling is the floor, not the mechanism. While a batch
    // is in flight the plan changes without anyone asking, so it tightens.
    refetchInterval: (query) => {
      const state = query.state.data?.processing.state;
      const interval = state === 'queued' || state === 'running' ? 1500 : CLIENT_POLL_MS;
      return pollUnlessFailed(query.state.status, interval);
    },
    structuralSharing: (previous, next) => {
      const before = previous as SnapshotResponse | undefined;
      const after = next as SnapshotResponse;
      // A slow response that lost the race must not overwrite newer state.
      if (before !== undefined && isNewerVersion(before.calendar_version, after.calendar_version)) {
        return before;
      }
      return after;
    },
  });
}

export function useMessages(tripId: string): UseQueryResult<ListMessagesResponse> {
  return useQuery({
    queryKey: messagesKey(tripId),
    queryFn: () => api.messages(tripId, { limit: 100 }),
    retry: retryUnlessUnreachable,
    refetchInterval: (query) => pollUnlessFailed(query.state.status, CLIENT_POLL_MS),
  });
}

/** Refetches both authoritative reads. Mutations end here, never in cache edits. */
export function useRefresh(tripId: string): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: snapshotKey(tripId) }),
      queryClient.invalidateQueries({ queryKey: messagesKey(tripId) }),
    ]);
  };
}

/**
 * Realtime notifications trigger an authoritative reread rather than patching
 * the cache from the payload, so a dropped or out-of-order notification costs a
 * refetch instead of corrupting what is on screen.
 */
export function useTripRealtime(tripId: string, enabled: boolean): void {
  const refresh = useRefresh(tripId);
  useEffect(() => {
    // Only once the trip is known to be readable. Opening a socket for a trip
    // this identity cannot see just produces a connection that is closed again
    // before it finishes opening.
    if (!enabled) return;
    return subscribeToTrip(tripId, {
      onCalendarChange: () => void refresh(),
      onMessage: () => void refresh(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, enabled]);
}

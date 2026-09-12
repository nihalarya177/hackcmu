import {
  REALTIME_TABLES,
  realtimeMessageRow,
  realtimeTripRow,
  type RealtimeMessageRow,
} from '@trip/contracts';
import { supabase } from './supabase';

/**
 * Realtime as an invalidation hint, never as a transport.
 *
 * Postgres Changes delivers JSON, and a bigint version arrives as a JavaScript
 * number that has already lost precision. Converting it back to a string
 * cannot recover what was dropped, so nothing here is treated as authoritative:
 * a notification only says "something changed, go and read it properly".
 */
export function subscribeToTrip(
  tripId: string,
  handlers: { onCalendarChange: () => void; onMessage: (row: RealtimeMessageRow) => void },
): () => void {
  const channel = supabase()
    .channel(`trip:${tripId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: REALTIME_TABLES[0], filter: `id=eq.${tripId}` },
      (payload) => {
        // Parsed only to confirm the shape; the values are not used as state.
        if (realtimeTripRow.safeParse(payload.new).success) handlers.onCalendarChange();
      },
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: REALTIME_TABLES[1],
        filter: `trip_id=eq.${tripId}`,
      },
      (payload) => {
        const parsed = realtimeMessageRow.safeParse(payload.new);
        if (parsed.success) handlers.onMessage(parsed.data);
      },
    )
    .subscribe();

  return () => {
    void supabase().removeChannel(channel);
  };
}

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { PROCESSING_LIMITS } from '@trip/contracts';
import { place, trip, type Database } from '@trip/db';
import { normalizeHours } from '../places/hours.js';
import { placeDetails, searchPlaces } from '../places/geoapify.js';
import { enumerateTripDates } from '../domain/tripDates.js';

export interface EnrichConfig {
  apiKey: string;
  enabled: boolean;
  dailyRequestLimit: number;
}

/**
 * One enrichment step: resolve a venue somebody named in words.
 *
 * The work is leased in the database, the network calls happen outside every
 * transaction, and the commit is fenced by both the lease token and the place
 * revision — so a slow worker that lost its lease, or whose place was edited
 * while it was away, cannot write stale data over newer truth.
 *
 * A human correction is never overwritten. That is checked again at commit
 * time, not only when the work was claimed.
 */
export async function enrichOnce(db: Database, config: EnrichConfig): Promise<boolean> {
  if (!config.enabled) return false;

  const leaseToken = randomUUID();
  const claimed = await db.execute(sql`
    update place
       set enrichment_lease_token = ${leaseToken},
           enrichment_lease_expires_at = now() + make_interval(secs => ${PROCESSING_LIMITS.leaseSeconds}),
           enrichment_attempts = enrichment_attempts + 1,
           updated_at = now()
     where id = (
       select id from place
        where resolution = 'pending'
          and human_override = false
          and search_query is not null
          and enrichment_attempts < ${PROCESSING_LIMITS.automaticAttempts}
          and (enrichment_due_at is null or enrichment_due_at <= now())
          and (enrichment_lease_expires_at is null or enrichment_lease_expires_at < now())
        order by created_at asc
        for update skip locked
        limit 1
     )
    returning id, trip_id, search_query, revision
  `);

  const row = (claimed as unknown as { rows?: Record<string, unknown>[] }).rows?.[0];
  if (row === undefined) return false;

  const placeId = row['id'] as string;
  const tripId = row['trip_id'] as string;
  const query = row['search_query'] as string;
  const claimedRevision = BigInt(String(row['revision']));

  const tripRows = await db.select().from(trip).where(eq(trip.id, tripId)).limit(1);
  const tripRow = tripRows[0];
  if (tripRow === undefined) return true;

  try {
    const provider = {
      apiKey: config.apiKey,
      center: { lat: tripRow.destinationLat, lon: tripRow.destinationLon },
    };

    const candidates = await searchPlaces(provider, query, 1);
    const best = candidates[0];
    if (best === undefined || best.lat === null || best.lon === null) {
      await markUnresolved(db, placeId, leaseToken, claimedRevision);
      return true;
    }

    const details =
      best.providerPlaceId === null ? null : await placeDetails(provider, best.providerPlaceId);

    const coordinate = { lat: best.lat, lon: best.lon };
    const dates = enumerateTripDates(tripRow.startDate, tripRow.endDate);
    const hours =
      details?.openingHoursRaw == null
        ? null
        : normalizeHours({
            raw: details.openingHoursRaw,
            dates,
            timezone: tripRow.timezone,
          });

    await db.transaction(async (tx) => {
      // Fenced on both the lease and the revision the work was claimed at,
      // and on human_override still being false.
      const updated = await tx
        .update(place)
        .set({
          label: best.label,
          address: best.address ?? details?.address ?? null,
          lat: coordinate.lat,
          lon: coordinate.lon,
          providerPlaceId: best.providerPlaceId,
          resolution: 'resolved',
          // No usable expression means the schedule stays unknown, which is
          // not the same as closed.
          hoursDays: hours ?? [],
          hoursProvenance: hours === null ? null : 'provider',
          hoursSourceRaw: details?.openingHoursRaw ?? null,
          hoursObservedAt: hours === null ? null : new Date(),
          fetchedAt: new Date(),
          enrichmentLeaseToken: null,
          enrichmentLeaseExpiresAt: null,
          enrichmentDueAt: null,
          revision: sql`${place.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(place.id, placeId),
            eq(place.enrichmentLeaseToken, leaseToken),
            eq(place.revision, claimedRevision),
            eq(place.humanOverride, false),
          ),
        )
        .returning({ id: place.id });

      // Shared venue metadata changed, so the calendar version moves and any
      // hours warning is re-evaluated on the next read.
      if (updated[0] !== undefined) {
        await tx
          .update(trip)
          .set({ calendarVersion: sql`${trip.calendarVersion} + 1`, updatedAt: new Date() })
          .where(eq(trip.id, tripId));
      }
    });
  } catch {
    // Back off and let it be retried; the attempt counter bounds it.
    await db
      .update(place)
      .set({
        enrichmentLeaseToken: null,
        enrichmentLeaseExpiresAt: null,
        enrichmentDueAt: sql`now() + make_interval(secs => 30)`,
        updatedAt: new Date(),
      })
      .where(and(eq(place.id, placeId), eq(place.enrichmentLeaseToken, leaseToken)));
  }

  return true;
}

/** The provider had nothing usable. The stop stays honestly unresolved. */
async function markUnresolved(
  db: Database,
  placeId: string,
  leaseToken: string,
  claimedRevision: bigint,
): Promise<void> {
  await db
    .update(place)
    .set({
      resolution: 'unresolved',
      fetchedAt: new Date(),
      enrichmentLeaseToken: null,
      enrichmentLeaseExpiresAt: null,
      enrichmentDueAt: null,
      revision: sql`${place.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(place.id, placeId),
        eq(place.enrichmentLeaseToken, leaseToken),
        eq(place.revision, claimedRevision),
      ),
    );
}

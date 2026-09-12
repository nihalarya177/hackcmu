import { and, eq, gt, sql } from 'drizzle-orm';
import {
  PLACE_CANDIDATE_TTL_SECONDS,
  RATE_LIMITS,
  type PlaceSearchRequest,
  type PlaceSearchResponse,
} from '@trip/contracts';
import { placeCandidate, type Database } from '@trip/db';
import type { Executor } from './types.js';
import { AppError } from './errors.js';
import { scopeHash } from './hash.js';
import { requireMembership } from './membership.js';
import { reserveRequest } from './rateLimit.js';
import { searchPlaces } from '../places/geoapify.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PlaceSearchDeps {
  db: Database;
  apiKey: string | null;
  enabled: boolean;
}

/**
 * Destination-biased search, run on the server.
 *
 * The browser never calls the provider and never sees the key. What it gets
 * back is a set of opaque references to rows this server stored; picking one
 * replays our own record rather than trusting anything the client composed.
 */
export async function searchForTrip(
  deps: PlaceSearchDeps,
  authUserId: string,
  tripId: string,
  body: PlaceSearchRequest,
): Promise<PlaceSearchResponse> {
  const { trip: tripRow } = await requireMembership(deps.db, tripId, authUserId);

  // Disabled or unreachable is reported, not thrown: typing the venue by hand
  // still works, and the UI needs to know which situation it is in.
  if (!deps.enabled || deps.apiKey === null) {
    return { candidates: [], expires_at: new Date().toISOString(), provider_unavailable: true };
  }

  await reserveRequest(deps.db, {
    scope: scopeHash('place_search', authUserId),
    endpointClass: 'place_search',
    limit: RATE_LIMITS.placeSearchesPerMinutePerSession,
    windowSeconds: 60,
  });

  let results;
  try {
    results = await searchPlaces(
      {
        apiKey: deps.apiKey,
        center: { lat: tripRow.destinationLat, lon: tripRow.destinationLon },
      },
      body.query,
      5,
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'DEPENDENCY_UNAVAILABLE') {
      return { candidates: [], expires_at: new Date().toISOString(), provider_unavailable: true };
    }
    throw error;
  }

  const expiresAt = new Date(Date.now() + PLACE_CANDIDATE_TTL_SECONDS * 1000);
  const stored = await deps.db
    .insert(placeCandidate)
    .values(
      results.map((row) => ({
        authUserId,
        tripId,
        query: body.query,
        label: row.label,
        address: row.address,
        lat: row.lat,
        lon: row.lon,
        timezone: tripRow.timezone,
        providerPlaceId: row.providerPlaceId,
        raw: row.raw,
        expiresAt,
      })),
    )
    .returning();

  return {
    candidates: stored.map((row) => ({
      // Opaque to the client: it means nothing without our row.
      candidate_ref: row.id,
      label: row.label,
      address: row.address,
      coordinate: row.lat === null || row.lon === null ? null : { lat: row.lat, lon: row.lon },
      timezone: row.timezone,
    })),
    expires_at: expiresAt.toISOString(),
    provider_unavailable: false,
  };
}

/**
 * Resolves a reference the caller replayed.
 *
 * Scoped to the same session and trip that searched, and expired references
 * are refused rather than silently reused.
 */
export async function resolveCandidate(
  db: Database | Executor,
  authUserId: string,
  tripId: string,
  candidateRef: string,
): Promise<typeof placeCandidate.$inferSelect> {
  // The reference is opaque to the client but it is still our uuid; anything
  // else never reaches the database as a malformed query.
  if (!UUID.test(candidateRef)) {
    throw new AppError('UNPROCESSABLE', 'That search result is no longer valid. Search again.');
  }

  const rows = await db
    .select()
    .from(placeCandidate)
    .where(
      and(
        eq(placeCandidate.id, candidateRef),
        eq(placeCandidate.authUserId, authUserId),
        eq(placeCandidate.tripId, tripId),
        gt(placeCandidate.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new AppError(
      'UNPROCESSABLE',
      'That search result has expired. Search again and pick one.',
    );
  }
  return row;
}

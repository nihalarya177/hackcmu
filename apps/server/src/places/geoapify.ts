import { PROCESSING_LIMITS } from '@trip/contracts';
import { AppError } from '../domain/errors.js';

export interface Candidate {
  label: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  providerPlaceId: string | null;
  /** The geocoder's own opinion of the match, 0 to 1. Often 0 for a bad hit. */
  confidence: number | null;
  categories: string[];
  raw: unknown;
}

export interface PlaceDetails {
  address: string | null;
  lat: number | null;
  lon: number | null;
  /** OSM opening-hours grammar as the provider returned it, unparsed. */
  openingHoursRaw: string | null;
}

/**
 * Geoapify, called server-side only.
 *
 * The key never reaches the browser and the client never constructs a provider
 * URL: it asks this server for candidates and replays an opaque reference to
 * the one a person picked.
 */
export interface ProviderConfig {
  apiKey: string;
  /** Results are biased towards the trip's destination, not the whole world. */
  center: { lat: number; lon: number };
}

export async function searchPlaces(
  config: ProviderConfig,
  query: string,
  limit = 5,
): Promise<Candidate[]> {
  const url = new URL('https://api.geoapify.com/v1/geocode/search');
  url.searchParams.set('text', query);
  url.searchParams.set('bias', `proximity:${config.center.lon},${config.center.lat}`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('format', 'json');
  url.searchParams.set('apiKey', config.apiKey);

  const payload = await call<{ results?: Record<string, unknown>[] }>(url);
  return (payload.results ?? []).map((row) => {
    const rank = row['rank'] as { confidence?: unknown } | undefined;
    return {
      label: asString(row['name']) ?? asString(row['address_line1']) ?? query,
      address: asString(row['formatted']),
      lat: asNumber(row['lat']),
      lon: asNumber(row['lon']),
      providerPlaceId: asString(row['place_id']),
      confidence: asNumber(rank?.confidence),
      categories: Array.isArray(row['categories'])
        ? (row['categories'] as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      raw: row,
    };
  });
}

export async function placeDetails(
  config: ProviderConfig,
  providerPlaceId: string,
): Promise<PlaceDetails | null> {
  const url = new URL('https://api.geoapify.com/v2/place-details');
  url.searchParams.set('id', providerPlaceId);
  url.searchParams.set('features', 'details');
  url.searchParams.set('apiKey', config.apiKey);

  const payload = await call<{
    features?: { properties?: Record<string, unknown> }[];
  }>(url);
  const properties = payload.features?.[0]?.properties;
  if (properties === undefined) return null;

  return {
    address: asString(properties['formatted']),
    lat: asNumber(properties['lat']),
    lon: asNumber(properties['lon']),
    openingHoursRaw: asString(properties['opening_hours']),
  };
}

async function call<T>(url: URL): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROCESSING_LIMITS.providerTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      // Only the status travels on; the provider body may echo the query.
      throw new AppError('DEPENDENCY_UNAVAILABLE', `places_http_${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new AppError('DEPENDENCY_UNAVAILABLE', aborted ? 'places_timeout' : 'places_unreachable');
  } finally {
    clearTimeout(timeout);
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

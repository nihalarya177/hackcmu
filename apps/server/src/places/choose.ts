import { PROCESSING_LIMITS } from '@trip/contracts';
import { AppError } from '../domain/errors.js';
import type { Candidate } from './geoapify.js';

export interface ChooserConfig {
  apiKey: string;
  model: string;
}

export interface Choice {
  /** Index into the candidates, or null when none of them is the place. */
  index: number | null;
  /** A better search phrase to try, when none of the candidates matched. */
  retryQuery: string | null;
}

const SYSTEM = `You match a venue somebody named in a group chat to one of several geocoder results.

The chat phrase is casual and often incomplete: "pittsburgh zoo", "the aviary",
"sandcastle waterpark". The geocoder returns whatever its index contains, which
frequently includes trails, car parks, streets and unrelated businesses whose
names merely overlap.

Pick the candidate that a person saying that phrase would actually mean. Prefer
the actual attraction over a footpath, entrance, car park or street named after
it. If none of them is that place, say so and give a better search phrase — the
venue's full proper name plus its city — so it can be looked up again.

Answer only with the JSON object described by the schema.`;

const SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'integer', nullable: true },
    retry_query: { type: 'string', nullable: true },
    reason: { type: 'string' },
  },
  required: ['index', 'retry_query', 'reason'],
} as const;

/**
 * Asks the model which geocoder result is the place somebody meant.
 *
 * The model chooses; it never supplies the coordinates. Every position stored
 * still comes from the geocoder, because a fabricated latitude and longitude
 * is indistinguishable from a real one once it is a pin on a map. What the
 * model is good at — knowing that "pittsburgh zoo" means the zoo and not Old
 * Zoo Trail — is exactly what the geocoder's ranking was getting wrong.
 */
export async function chooseCandidate(
  config: ChooserConfig,
  query: string,
  candidates: Candidate[],
): Promise<Choice> {
  if (candidates.length === 0) return { index: null, retryQuery: null };

  const listed = candidates
    .map(
      (row, index) =>
        `${index}. name=${row.label ?? '(none)'} | address=${row.address ?? '(none)'} | categories=${(row.categories ?? []).slice(0, 4).join(',') || '(none)'}`,
    )
    .join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROCESSING_LIMITS.providerTimeoutMs);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [
            {
              role: 'user',
              parts: [{ text: `Someone said: "${query}"\n\nCandidates:\n${listed}` }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: SCHEMA,
            temperature: 0,
            maxOutputTokens: 400,
          },
        }),
      },
    );
    if (!response.ok)
      throw new AppError('DEPENDENCY_UNAVAILABLE', `chooser_http_${response.status}`);

    const payload = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
    if (text === undefined || text.trim() === '') return { index: null, retryQuery: null };

    const parsed = JSON.parse(text) as { index?: unknown; retry_query?: unknown };
    const index =
      typeof parsed.index === 'number' && parsed.index >= 0 && parsed.index < candidates.length
        ? parsed.index
        : null;
    const retryQuery =
      typeof parsed.retry_query === 'string' && parsed.retry_query.trim() !== ''
        ? parsed.retry_query.trim()
        : null;
    return { index, retryQuery };
  } catch {
    // The chooser is an improvement on the ranking, not a dependency. If it is
    // unavailable the caller falls back to the geocoder's own confidence.
    return { index: null, retryQuery: null };
  } finally {
    clearTimeout(timeout);
  }
}

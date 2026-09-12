import { PROCESSING_LIMITS } from '@trip/contracts';
import { AppError } from '../domain/errors.js';
import { RESPONSE_SCHEMA, SYSTEM_PROMPT } from './prompt.js';

export interface ExtractionRequest {
  model: string;
  apiKey: string;
  userPrompt: string;
}

export interface ExtractionResult {
  /** Raw JSON text. Parsed and validated by the caller, never trusted here. */
  text: string;
  promptTokens: number;
  outputTokens: number;
}

/**
 * The official REST surface, called statelessly.
 *
 * No tools, no search grounding, no streaming, and no client-side retry: the
 * durable scheduler owns retries, and an SDK retrying underneath it would
 * multiply provider calls against a lease that may already be lost.
 */
export async function extract(request: ExtractionRequest): Promise<ExtractionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROCESSING_LIMITS.providerTimeoutMs);

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The key travels in a header, never in the URL, so it cannot be
          // captured by request logging on the way.
          'x-goog-api-key': request.apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            // Extraction is not a creative task; the same chat should yield
            // the same operations.
            temperature: 0,
            maxOutputTokens: PROCESSING_LIMITS.outputTokenCap,
          },
        }),
      },
    );
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new AppError(
      'DEPENDENCY_UNAVAILABLE',
      aborted ? 'provider_timeout' : 'provider_unreachable',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // The provider's own message may quote the prompt, so only the status is
    // carried forward.
    throw new AppError('DEPENDENCY_UNAVAILABLE', `provider_http_${response.status}`);
  }

  const payload = (await response.json()) as {
    candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    promptFeedback?: { blockReason?: string };
  };

  const blocked = payload.promptFeedback?.blockReason;
  if (blocked !== undefined) {
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'provider_blocked_request');
  }

  const candidate = payload.candidates?.[0];
  if (candidate === undefined) {
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'provider_returned_no_candidate');
  }
  // A truncated answer is a failed attempt, not an empty successful batch:
  // treating it as "nothing to do" would silently drop real agreements.
  if (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') {
    throw new AppError(
      'DEPENDENCY_UNAVAILABLE',
      `provider_${candidate.finishReason.toLowerCase()}`,
    );
  }

  const text = candidate.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (text.trim() === '') {
    throw new AppError('DEPENDENCY_UNAVAILABLE', 'provider_returned_empty_text');
  }

  return {
    text,
    promptTokens: payload.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

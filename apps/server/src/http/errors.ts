import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  statusForErrorCode,
  type ApiError,
  type ErrorCode,
  type FieldError,
} from '@trip/contracts';
import { AppError, describeError } from '../domain/errors.js';

function fieldErrorsFromZod(error: z.ZodError): FieldError[] {
  return error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/** Rejects a request body or query that does not match its contract. */
export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', 'The request did not match the expected shape', {
      fieldErrors: fieldErrorsFromZod(parsed.error),
    });
  }
  return parsed.data;
}

function buildBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  extras: Partial<ApiError['error']> = {},
): ApiError {
  return { error: { code, message, request_id: requestId, ...extras } };
}

/**
 * Single exit point for every failure.
 *
 * Only AppError messages reach the client. Anything else is logged in full and
 * reported as INTERNAL with just a request id, so SQL text, driver details and
 * provider responses cannot leak through an error body.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      const extras: Partial<ApiError['error']> = {};
      if (error.fieldErrors !== undefined) extras.field_errors = error.fieldErrors;
      if (error.currentCalendarVersion !== undefined) {
        extras.current_calendar_version = error.currentCalendarVersion.toString();
      }
      if (error.retryAfterSeconds !== undefined) {
        extras.retry_after_seconds = error.retryAfterSeconds;
        void reply.header('retry-after', String(error.retryAfterSeconds));
      }
      request.log.info(
        { err_code: error.code, trip_id: (request.params as { tripId?: string }).tripId },
        'request rejected',
      );
      void reply
        .status(statusForErrorCode(error.code))
        .send(buildBody(error.code, error.message, requestId, extras));
      return;
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode === 413) {
      void reply.status(413).send(buildBody('BAD_REQUEST', 'Request body is too large', requestId));
      return;
    }
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      void reply
        .status(400)
        .send(buildBody('BAD_REQUEST', 'The request could not be understood', requestId));
      return;
    }

    // Never log the raw error: its message can carry bound parameters,
    // which include invite tokens and stored receipt payloads.
    request.log.error({ err: describeError(error) }, 'unhandled error');
    void reply.status(500).send(buildBody('INTERNAL', 'Something went wrong', requestId));
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(404).send(buildBody('NOT_FOUND', 'No such endpoint', request.id));
  });
}

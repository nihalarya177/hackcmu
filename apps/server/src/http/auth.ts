import type { FastifyRequest } from 'fastify';
import { AppError } from '../domain/errors.js';
import type { AuthenticatedUser } from '../auth/verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook before any handler runs. */
    authUser: AuthenticatedUser | null;
  }
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Every application endpoint requires a verified session. */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (request.authUser === null) {
    throw new AppError('UNAUTHENTICATED', 'A valid session is required');
  }
  return request.authUser;
}

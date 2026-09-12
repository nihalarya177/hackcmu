import { describe, expect, it } from 'vitest';
import { describeError, isUniqueViolation } from '../../apps/server/src/domain/errors.js';

/** Shape of the driver error the query builder wraps. */
function pgError(constraint: string): Error & { code: string; constraint: string } {
  return Object.assign(
    new Error(
      `duplicate key value violates unique constraint "${constraint}"\nparams: secret-invite-token`,
    ),
    { code: '23505', constraint },
  );
}

describe('unique violation detection', () => {
  it('recognises a bare driver error', () => {
    expect(isUniqueViolation(pgError('command_receipt_user_command_key'))).toBe(true);
  });

  it('recognises a driver error wrapped by the query builder', () => {
    // The query builder rethrows with the driver error as a cause, so checking
    // only the outer object turns an expected replay into a 500.
    const wrapped = new Error('Failed query: insert into command_receipt', {
      cause: pgError('command_receipt_user_command_key'),
    });
    expect(isUniqueViolation(wrapped, 'command_receipt_user_command_key')).toBe(true);
  });

  it('does not match a different constraint', () => {
    const wrapped = new Error('Failed query', { cause: pgError('person_trip_color_key') });
    expect(isUniqueViolation(wrapped, 'command_receipt_user_command_key')).toBe(false);
  });

  it('does not match a different sqlstate', () => {
    const foreignKey = Object.assign(new Error('fk'), { code: '23503' });
    expect(isUniqueViolation(foreignKey)).toBe(false);
  });

  it('ignores plain values', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('error description for logs', () => {
  it('drops bound parameters, which can contain invite tokens', () => {
    const described = describeError(
      new Error('Failed query: insert ...', { cause: pgError('trip_invite_token_hash_key') }),
    );
    expect(JSON.stringify(described)).not.toContain('secret-invite-token');
    expect(described['sqlstate']).toBe('23505');
    expect(described['constraint']).toBe('trip_invite_token_hash_key');
  });

  it('truncates a very long message', () => {
    const described = describeError(new Error('x'.repeat(5000)));
    expect(described['message']?.length).toBeLessThanOrEqual(300);
  });
});

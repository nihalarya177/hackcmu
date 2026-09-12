import type { Database } from '@trip/db';

/** A drizzle transaction handle. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that can run a query: the pool or an open transaction. */
export type Executor = Database | Tx;

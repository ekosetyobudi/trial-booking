import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '@/lib/env';

// DATABASE_URL uses the Supabase session pooler (port 5432). Session mode
// pins one server connection per client, so row locks and multi-statement
// transactions behave as they would on a direct connection.
const client = postgres(env.DATABASE_URL);

export const db = drizzle(client);

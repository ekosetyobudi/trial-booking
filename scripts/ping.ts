import 'dotenv/config';

import postgres from 'postgres';

import { env } from '@/lib/env';

const sql = postgres(env.DATABASE_URL);

try {
  const [row] = await sql`select version()`;
  console.log(row?.version);
} finally {
  await sql.end();
}

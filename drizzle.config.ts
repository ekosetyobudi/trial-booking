import "dotenv/config";

import { defineConfig } from "drizzle-kit";

import { env } from "./src/lib/env";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});

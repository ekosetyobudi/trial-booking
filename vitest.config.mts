import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 20000,
    // Every test file shares one Postgres database. Running them in parallel
    // would let files overwrite each other's rows, producing failures that
    // look identical to a real locking bug.
    fileParallelism: false,
  },
});

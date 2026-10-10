import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // `server-only` throws outside the React server condition; tests run in plain Node.
  "server-only": path.resolve(import.meta.dirname, "test/server-only-stub.ts"),
};

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["test/unit/**/*.test.ts"], environment: "node" } },
      {
        resolve: { alias },
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
  },
});

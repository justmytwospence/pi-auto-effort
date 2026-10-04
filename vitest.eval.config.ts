import { defineConfig } from "vitest/config";

// Live evals against Jev through Pi's model registry. Skipped without TypeSafe credentials.
export default defineConfig({ test: { include: ["eval/**/*.eval.ts"], testTimeout: 120_000 } });

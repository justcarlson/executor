import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["fork/**/*.test.ts"], testTimeout: 120000 } });

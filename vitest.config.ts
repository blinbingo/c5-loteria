import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Testes tocam o MESMO banco (truncate entre eles) → sem paralelismo entre arquivos.
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});

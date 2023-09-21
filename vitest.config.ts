/// <reference types="vitest" />
import { defineConfig } from "vite";

export default defineConfig({
  test: {
    setupFiles: ["./__tests__/setup.ts"],
    include: ["./__tests__/**/*.test.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
  },
});

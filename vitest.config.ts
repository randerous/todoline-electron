import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // AppleDouble sidecars (._name) are created by exFAT/network volumes; they are
    // binary junk that matches the include glob, so keep them out of the run.
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.cache/**', '**/._*', '**/.*/**'],
    environment: 'jsdom',
    pool: 'forks',
    maxWorkers: 2,
  },
});

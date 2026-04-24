import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['scripts/**/*.test.ts'],
      include: ['scripts/lib/**/*.ts'],
      provider: 'v8',
    },
    include: ['scripts/**/*.test.ts'],
  },
});

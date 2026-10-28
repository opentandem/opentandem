import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // tests/node/ uses node:test and runs with `node --test` (see package.json).
    exclude: [...configDefaults.exclude, 'tests/node/**'],
  },
})

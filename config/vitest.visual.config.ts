import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/*/src/**/*.visual.test.ts'],
        testTimeout: 20000,
        reporters: ['dot'],
    },
});

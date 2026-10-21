import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],

        /*
         * Test files run one at a time.
         *
         * The integration tests share a single Postgres and truncate between
         * cases, so two files running concurrently tear down each other's
         * fixtures. That showed up as a suite which passed file by file and
         * failed when run together, which is the worst way for it to show up.
         *
         * The alternative is a schema per worker, which buys parallelism at
         * the cost of setup complexity. The whole suite runs in well under a
         * second, so there is nothing yet to buy.
         */
        fileParallelism: false,
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts'],
        },
    },
});

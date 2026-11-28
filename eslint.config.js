import { base, tests, typed } from '@jasonsdevspace/config/eslint';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

/*
 * The house's presets from @jasonsdevspace/config, which every project repository takes, and after
 * them the rules that name this repository's own folders. The project service reads each file's
 * own tsconfig, so the demo is checked against browser types and the service against Node's.
 */
export default defineConfig(
    ...base(),
    ...typed({ tsconfigRootDir: import.meta.dirname }),
    ...tests(),
    {
        // The demo runs in the browser, not in Node, its theme script among it.
        files: ['demo/src/**/*.{ts,tsx}', 'demo/theme.js'],
        languageOptions: { globals: globals.browser },
    },
    {
        // The code the browser demo runs, unchanged, against Postgres in the
        // page. It may use the driver's types but never load the driver or
        // anything from Node, or the demo stops building. Enforced here
        // rather than discovered there.
        files: [
            'src/domain/**/*.ts',
            'src/postgres/pool/connection.ts',
            'src/postgres/store/store.ts',
            'src/postgres/idempotency/idempotency.ts',
            'src/postgres/holds/sweeper.ts',
            'src/postgres/reconcile/reconcile.ts',
        ],
        ignores: ['**/*.test.ts'],
        rules: {
            '@typescript-eslint/no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'pg',
                            message: 'Runs in the browser. Use the types in pool/connection.ts.',
                            allowTypeImports: true,
                        },
                    ],
                    patterns: [
                        {
                            group: ['node:*', '../pool/pool.js', '*/pool/pool.js'],
                            message: 'Runs in the browser, so it cannot load Node or the driver.',
                        },
                    ],
                },
            ],
        },
    }
);

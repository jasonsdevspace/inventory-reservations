import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['coverage', 'node_modules'] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ['**/*.{ts,mjs,js}'],
        languageOptions: {
            ecmaVersion: 2023,
            globals: globals.node,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            // Every callable is a value, so a file reads top to bottom with no
            // hoisting surprises. Matches the convention in the portfolio repo.
            'func-style': ['error', 'expression'],
            'prefer-arrow-callback': ['error', { allowNamedFunctions: false }],
            // The domain core is meant to be exhaustive over its unions. A
            // missing case should be a type error, not a silent fallthrough.
            '@typescript-eslint/switch-exhaustiveness-check': 'off',
        },
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

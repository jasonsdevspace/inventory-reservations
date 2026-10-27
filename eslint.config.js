import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/*
 * Three kinds of rule live here.
 *
 * Mechanical ones, such as import order, are fixed by `eslint --fix` and
 * exist so a diff never carries reordering noise. Bug catchers, from
 * typescript-eslint's type-aware set and SonarJS, flag code that is wrong
 * rather than code that is unusual. Size budgets catch a function that has
 * grown past what a reader can hold at once. Everything is an error, since
 * a warning that does not fail the build is a rule nobody follows.
 */

/** Rules that fire on real mistakes and almost never on style. */
const bugCatchers = {
    'sonarjs/no-identical-conditions': 'error',
    'sonarjs/no-identical-expressions': 'error',
    'sonarjs/no-all-duplicated-branches': 'error',
    'sonarjs/no-element-overwrite': 'error',
    'sonarjs/no-ignored-return': 'error',
    'sonarjs/no-use-of-empty-return-value': 'error',
    'sonarjs/no-empty-collection': 'error',
    'sonarjs/no-unused-collection': 'error',
    'sonarjs/no-collection-size-mischeck': 'error',
    'sonarjs/no-extra-arguments': 'error',
    'sonarjs/no-gratuitous-expressions': 'error',
    'sonarjs/no-redundant-jump': 'error',
    eqeqeq: ['error', 'always'],
    'no-param-reassign': 'error',
    'array-callback-return': 'error',
    'no-return-assign': 'error',
};

/** How large a function may grow before it should be split. */
const sizeBudgets = {
    complexity: ['error', 15],
    'sonarjs/cognitive-complexity': ['error', 15],
    'max-depth': ['error', 4],
    'max-params': ['error', 4],
};

export default tseslint.config(
    { ignores: ['**/coverage', '**/node_modules', '**/dist'] },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        files: ['**/*.{ts,tsx,mjs,js}'],
        languageOptions: {
            ecmaVersion: 2023,
            globals: globals.node,
        },
        plugins: { 'simple-import-sort': simpleImportSort, 'import-x': importX, sonarjs },
        rules: {
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            // Every callable is a value, so a file reads top to bottom with no
            // hoisting surprises. Matches the convention in the portfolio repo.
            'func-style': ['error', 'expression'],
            'prefer-arrow-callback': ['error', { allowNamedFunctions: false }],
            'simple-import-sort/imports': 'error',
            'simple-import-sort/exports': 'error',
            'import-x/first': 'error',
            'import-x/newline-after-import': 'error',
            'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
            ...bugCatchers,
            ...sizeBudgets,
        },
    },
    {
        // Rules that need the types. The project service reads each file's
        // own tsconfig, so the demo is checked against browser types and the
        // service against Node's.
        files: ['**/*.{ts,tsx}'],
        extends: [...tseslint.configs.recommendedTypeChecked],
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ['demo/vite.config.ts'] },
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',
            '@typescript-eslint/require-array-sort-compare': 'error',
            '@typescript-eslint/prefer-nullish-coalescing': 'error',
            '@typescript-eslint/prefer-optional-chain': 'error',
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/prefer-readonly': 'error',
            // The domain core is meant to be exhaustive over its unions, and
            // this is what makes a missing case fail the build.
            '@typescript-eslint/switch-exhaustiveness-check': 'error',
        },
    },
    {
        // Tests read whatever a response or a row happens to contain.
        files: ['**/*.test.{ts,tsx}'],
        rules: {
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            'max-params': 'off',
            'sonarjs/cognitive-complexity': 'off',
        },
    },
    {
        // The demo runs in the browser, not in Node.
        files: ['demo/src/**/*.{ts,tsx}'],
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

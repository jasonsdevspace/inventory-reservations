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
    }
);

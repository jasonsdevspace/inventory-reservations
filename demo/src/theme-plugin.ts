import { readFileSync } from 'node:fs';

import type { Plugin } from 'vite';

/**
 * The pre-paint theme script, written once in theme.js and put into every
 * page's head where the page says so. Inline, so it runs before the first
 * paint and the page never flashes the other theme, and from one file, so
 * the pages cannot drift on the storage key or the fallback.
 */
const PLACEHOLDER = '<!-- theme-script -->';

export const themeScript = (): Plugin => ({
    name: 'inventory-theme-script',
    transformIndexHtml: {
        order: 'pre',
        handler: (html) => {
            if (!html.includes(PLACEHOLDER)) {
                throw new Error(`a page has no place for the theme script: ${PLACEHOLDER}`);
            }
            const script = readFileSync(new URL('../theme.js', import.meta.url), 'utf8');
            // A function, so nothing in the script reads as a replacement pattern.
            return html.replace(PLACEHOLDER, () => `<script>\n${script}</script>`);
        },
    },
});

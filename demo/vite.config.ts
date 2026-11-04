/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { themeScript } from './src/theme-plugin.js';

/*
 * The demo imports the service's own modules from ../src rather than copies
 * of them, so the file server is allowed to reach the parent directory.
 *
 * PGlite ships its own WebAssembly and data files and loads them relative to
 * itself, which the dependency optimizer would break by moving the module.
 *
 * DEMO_BASE is the path the site is served under. GitHub Pages serves a
 * project site from /<repository>/, and local development from /.
 *
 * The explainer at about/ is a second page, so it is listed as an input
 * beside the demo's own, or the build would leave it out. Its entry only
 * starts the visit counter, so the counter is the one script chunk the two
 * pages share and the explainer never loads the demo's database client.
 */
export default defineConfig({
    base: process.env.DEMO_BASE ?? '/',
    plugins: [react(), themeScript()],
    server: { fs: { allow: ['..'] } },
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    build: {
        target: 'es2023',
        rolldownOptions: {
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                about: fileURLToPath(new URL('./about/index.html', import.meta.url)),
            },
        },
    },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
});

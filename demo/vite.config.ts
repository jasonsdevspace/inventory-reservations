/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { failOnWarning } from './src/build-logs.js';
import { themeScript } from './src/theme-plugin.js';

/*
 * The demo imports the service's own modules from ../src rather than copies
 * of them, so the file server is allowed to reach the parent directory.
 *
 * PGlite ships its own WebAssembly and data files and loads them relative to
 * itself, which the dependency optimizer would break by moving the module.
 *
 * DEMO_BASE is the path the site is served under. GitHub Pages serves a
 * project site from /<repository>/. Left unset, the base is /, which is
 * what local development uses.
 *
 * The explainer at about/ is a second page, so it is listed as an input
 * beside the demo's own, or the build would leave it out. Its entry only
 * starts the visit counter, so the counter is the one script chunk the two
 * pages share and the explainer never loads the demo's database client.
 *
 * A bundler warning fails the build, as build-logs.ts explains. Vite's
 * notice that a chunk is large is printed by Vite itself, never reaches that
 * check, and cannot fail anything. PGlite's client puts the main chunk past
 * Vite's default limit, so the notice would print on every build and teach
 * a reader to skip the output. The limit, in minified kB, sits above the
 * chunk as it is, and the Lighthouse audit in CI holds the page's script to
 * 250 KB gzipped.
 */
export default defineConfig({
    base: process.env.DEMO_BASE ?? '/',
    plugins: [react(), themeScript()],
    server: { fs: { allow: ['..'] } },
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    build: {
        target: 'es2023',
        chunkSizeWarningLimit: 1024,
        rolldownOptions: {
            onLog: failOnWarning,
            input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                about: fileURLToPath(new URL('./about/index.html', import.meta.url)),
            },
        },
    },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
});

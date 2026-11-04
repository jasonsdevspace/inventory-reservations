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
 * project site from /<repository>/, and local development from /.
 *
 * The explainer at about/ is a second page, so it is listed as an input
 * beside the demo's own, or the build would leave it out. Its entry only
 * starts the visit counter, so the counter is the one script chunk the two
 * pages share and the explainer never loads the demo's database client.
 *
 * A warning from the bundler fails the build, PGlite's aside, as
 * build-logs.ts says. PGlite's client is also most of the demo's script,
 * which Vite's default warns about past 500 kB. The Lighthouse audit is what
 * holds the page's script, at 250 KB gzipped, so that warning is raised past
 * where the demo is.
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

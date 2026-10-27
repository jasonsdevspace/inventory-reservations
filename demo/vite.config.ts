/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/*
 * The demo imports the service's own modules from ../src rather than copies
 * of them, so the file server is allowed to reach the parent directory.
 *
 * PGlite ships its own WebAssembly and data files and loads them relative to
 * itself, which the dependency optimizer would break by moving the module.
 *
 * DEMO_BASE is the path the site is served under. GitHub Pages serves a
 * project site from /<repository>/, and local development from /.
 */
export default defineConfig({
    base: process.env.DEMO_BASE ?? '/',
    plugins: [react()],
    server: { fs: { allow: ['..'] } },
    optimizeDeps: { exclude: ['@electric-sql/pglite'] },
    build: { target: 'es2023' },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
});

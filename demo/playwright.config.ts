import { defineConfig, devices } from '@playwright/test';

/**
 * The demo in a real browser, served as GitHub Pages serves it.
 *
 * `npm run e2e` runs against `dist`, so what is tested is the production
 * build, Postgres in the page included, and not the dev server. The build
 * carries its base path, and the preview server reads the same config, so
 * a build made with DEMO_BASE set is served and visited under that path.
 * Desktop and phone, since the page reflows on a narrow screen.
 */
const base = process.env.DEMO_BASE ?? '/';
const url = `http://localhost:4173${base}`;

export default defineConfig({
    testDir: 'e2e',
    fullyParallel: true,
    // Each page boots Postgres on its main thread, so on the shared runner the
    // tests take turns rather than competing for the CPU during the boot.
    ...(process.env.CI ? { workers: 1 } : {}),
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: url,
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
        { name: 'phone', use: { ...devices['Pixel 7'] } },
    ],
    webServer: {
        command: 'npx vite preview --port 4173 --strictPort',
        url,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});

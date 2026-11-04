import type { Rolldown } from 'vite';

/**
 * A warning from the bundler fails the build, so a new one is read rather
 * than scrolled past. PGlite's own are let through, since its Emscripten
 * code holds direct eval and a Node import on paths only Node takes.
 */
const fromPglite = (log: Rolldown.RolldownLog): boolean =>
    (log.id ?? log.message).includes('@electric-sql/pglite');

/** Lets the bundler's logs through, and fails the build on any warning not PGlite's. */
export const failOnWarning: NonNullable<Rolldown.InputOptions['onLog']> = (level, log, handler) => {
    if (level !== 'warn') return handler(level, log);
    if (fromPglite(log)) return;
    throw new Error(`the build warned: ${log.message}`);
};

import type { Rolldown } from 'vite';

/**
 * A warning from the bundler fails the build, so a new one is read rather
 * than scrolled past.
 *
 * Two kinds are let through, both from PGlite's Emscripten code, on paths
 * only Node takes: its direct eval, and its import of node:module, which Vite
 * replaces with an empty module in the browser. Each is matched by what the
 * bundler says about PGlite's own file, so the same warning about the demo's
 * code still fails.
 *
 * The warnings Vite decides on itself go to Vite: an import that does not
 * resolve, which it fails the build on, and the kinds it hides.
 */
const PGLITE = '/node_modules/@electric-sql/pglite/';
const EXTERNALIZED_FOR_PGLITE = new RegExp(
    `externalized for browser compatibility, imported by "[^"]*${PGLITE}`
);
const VITES_OWN = new Set(['UNRESOLVED_IMPORT', 'CIRCULAR_DEPENDENCY', 'THIS_IS_UNDEFINED']);

const fromPglite = (log: Rolldown.RolldownLog): boolean =>
    (log.code === 'EVAL' && (log.id?.includes(PGLITE) ?? false)) ||
    (log.plugin === 'rolldown:vite-resolve' && EXTERNALIZED_FOR_PGLITE.test(log.message));

const described = (log: Rolldown.RolldownLog): string =>
    [log.plugin && `[plugin ${log.plugin}]`, log.code && `[${log.code}]`, log.id, log.message]
        .filter(Boolean)
        .join(' ');

/** Lets the bundler's logs through, and fails the build on any warning not PGlite's. */
export const failOnWarning: NonNullable<Rolldown.InputOptions['onLog']> = (level, log, handler) => {
    if (level !== 'warn' || (log.code !== undefined && VITES_OWN.has(log.code))) {
        return handler(level, log);
    }
    if (fromPglite(log)) return;
    throw new Error(`the build warned: ${described(log)}`);
};

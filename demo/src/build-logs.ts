import type { Rolldown } from 'vite';

/*
 * Any warning from Rolldown, the bundler Vite runs, fails the build, so a
 * new one is read rather than scrolled past.
 *
 * Two warnings from PGlite are let through. Both come from code PGlite runs
 * only under Node: a direct eval, and an import of node:module, which Vite
 * swaps for an empty module in a browser build. Each is matched on the
 * PGlite file the warning names, so the same warning about the demo's own
 * code still fails.
 *
 * The codes Vite already decides on go to its own handler. It fails the
 * build on UNRESOLVED_IMPORT and hides CIRCULAR_DEPENDENCY and
 * THIS_IS_UNDEFINED.
 */
const PGLITE = '/node_modules/@electric-sql/pglite/';
const EXTERNALIZED_FOR_PGLITE = new RegExp(
    `^Module "node:module" has been externalized for browser compatibility, imported by "[^"]*${PGLITE}`
);
const VITES_OWN = new Set(['UNRESOLVED_IMPORT', 'CIRCULAR_DEPENDENCY', 'THIS_IS_UNDEFINED']);

const fromPglite = (log: Rolldown.RolldownLog): boolean =>
    (log.code === 'EVAL' && (log.id?.includes(PGLITE) ?? false)) ||
    (log.plugin === 'rolldown:vite-resolve' && EXTERNALIZED_FOR_PGLITE.test(log.message));

// Rolldown's own messages open with their code, so the code is added only when one does not.
const described = (log: Rolldown.RolldownLog): string =>
    [
        log.plugin && `[plugin ${log.plugin}]`,
        log.code && !log.message.includes(`[${log.code}]`) && `[${log.code}]`,
        log.id,
        log.message,
    ]
        .filter(Boolean)
        .join(' ');

/** Fails the build on any warning that is not PGlite's or one Vite handles itself. */
export const failOnWarning: NonNullable<Rolldown.InputOptions['onLog']> = (level, log, handler) => {
    if (level !== 'warn' || (log.code !== undefined && VITES_OWN.has(log.code))) {
        return handler(level, log);
    }
    if (fromPglite(log)) return;
    throw new Error(`the build warned: ${described(log)}`);
};

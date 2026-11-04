import { describe, expect, it, vi } from 'vitest';

import { failOnWarning } from './build-logs.js';

// The warnings as a build of the demo gives them, cut to what is matched.
const PGLITE_CHUNK = '/repo/demo/node_modules/@electric-sql/pglite/dist/chunk-IVSF7R5H.js';
const EVAL_MESSAGE = '[EVAL] Use of direct `eval` function is strongly discouraged';
const pgliteEval = { code: 'EVAL', id: PGLITE_CHUNK, message: EVAL_MESSAGE };
const pgliteNodeImport = {
    plugin: 'rolldown:vite-resolve',
    message: `Module "node:module" has been externalized for browser compatibility, imported by "${PGLITE_CHUNK}". See https://vite.dev for more details.`,
};

describe('the build', () => {
    it("lets through PGlite's direct eval and its import of node:module", () => {
        const handler = vi.fn();
        failOnWarning('warn', pgliteEval, handler);
        failOnWarning('warn', pgliteNodeImport, handler);
        expect(handler).not.toHaveBeenCalled();
    });

    it("fails on the same warnings about the demo's own code, and says where", () => {
        const handler = vi.fn();
        expect(() =>
            failOnWarning('warn', { ...pgliteEval, id: '/repo/demo/src/main.tsx' }, handler)
        ).toThrow(`the build warned: [EVAL] /repo/demo/src/main.tsx ${EVAL_MESSAGE}`);
        expect(() =>
            failOnWarning(
                'warn',
                {
                    ...pgliteNodeImport,
                    message: pgliteNodeImport.message.replace(
                        PGLITE_CHUNK,
                        '/repo/demo/src/db/client.ts'
                    ),
                },
                handler
            )
        ).toThrow('[plugin rolldown:vite-resolve]');
        expect(handler).not.toHaveBeenCalled();
    });

    it('fails on any other warning, even one that names PGlite', () => {
        const message = `"Missing" is not exported by "${PGLITE_CHUNK}", imported by "src/db/client.ts".`;
        expect(() => failOnWarning('warn', { code: 'MISSING_EXPORT', message }, vi.fn())).toThrow(
            message
        );
    });

    it('leaves to Vite the warnings it decides on, from PGlite or not', () => {
        const handler = vi.fn();
        const unresolved = { code: 'UNRESOLVED_IMPORT', id: PGLITE_CHUNK, message: 'unresolved' };
        const hidden = {
            code: 'THIS_IS_UNDEFINED',
            id: '/repo/demo/src/main.tsx',
            message: 'this',
        };
        failOnWarning('warn', unresolved, handler);
        failOnWarning('warn', hidden, handler);
        expect(handler.mock.calls).toEqual([
            ['warn', unresolved],
            ['warn', hidden],
        ]);
    });

    it('passes every log that is not a warning on as it was', () => {
        const handler = vi.fn();
        const log = { message: 'transformed' };
        failOnWarning('info', log, handler);
        expect(handler).toHaveBeenCalledWith('info', log);
    });
});

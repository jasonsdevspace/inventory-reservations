import { describe, expect, it, vi } from 'vitest';

import { failOnWarning } from './build-logs.js';

const PGLITE = '/demo/node_modules/@electric-sql/pglite/dist/chunk.js';

describe('the build', () => {
    it("fails on a warning from the demo's own code", () => {
        const handler = vi.fn();
        expect(() =>
            failOnWarning(
                'warn',
                { code: 'EVAL', message: 'direct eval', id: '/demo/src/main.tsx' },
                handler
            )
        ).toThrow('the build warned: direct eval');
        expect(handler).not.toHaveBeenCalled();
    });

    it("lets PGlite's own warnings through, by the module or by the message that names it", () => {
        const handler = vi.fn();
        failOnWarning('warn', { code: 'EVAL', message: 'direct eval', id: PGLITE }, handler);
        failOnWarning(
            'warn',
            { message: `"node:module" externalized, imported by "${PGLITE}"` },
            handler
        );
        expect(handler).not.toHaveBeenCalled();
    });

    it('passes every log that is not a warning on as it was', () => {
        const handler = vi.fn();
        const log = { message: 'transformed' };
        failOnWarning('info', log, handler);
        expect(handler).toHaveBeenCalledWith('info', log);
    });
});

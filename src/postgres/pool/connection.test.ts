import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { reusableAfter } from './connection.js';

/*
 * Whether a connection survives an error is decided by the error's shape
 * rather than the driver's class, so the same rule holds for every driver.
 * These pin it against the errors the `pg` driver really produces.
 */
describe('reusableAfter', () => {
    it('keeps a connection after an error Postgres reported', () => {
        const reported = Object.assign(new pg.DatabaseError('duplicate key', 0, 'error'), {
            severity: 'ERROR',
            code: '23505',
        });
        expect(reusableAfter(reported)).toBe(true);
    });

    it('discards it after a socket error, even one whose code looks like a SQLSTATE', () => {
        const socket = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        expect(reusableAfter(socket)).toBe(false);
    });

    it('discards it after a client side timeout', () => {
        expect(reusableAfter(new Error('Query read timeout'))).toBe(false);
    });

    it('discards it after anything that is not an error at all', () => {
        expect(reusableAfter(undefined)).toBe(false);
        expect(reusableAfter('failed')).toBe(false);
    });
});

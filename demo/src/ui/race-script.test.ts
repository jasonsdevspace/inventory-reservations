import { describe, expect, it } from 'vitest';

import { RACES } from './race-script.js';

/*
 * The step-through computes each decision with the domain code. These pin
 * the outcomes the page describes, so the story and the code cannot drift.
 */
describe('the race step-through', () => {
    it('oversells with no concurrency control', () => {
        expect(RACES.none.accepted).toBe(2);
        expect(RACES.none.finalAvailable).toBe(-1);
    });

    it.each(['row_lock', 'serializable'] as const)('sells the unit once under %s', (strategy) => {
        const race = RACES[strategy];
        expect(race.accepted).toBe(1);
        expect(race.finalAvailable).toBe(0);
        expect(race.steps.at(-1)?.buyers.B).toMatchObject({
            kind: 'refused',
            rejection: { kind: 'insufficient_salable', available: 0 },
        });
    });

    it('makes B wait under row lock and abort under serializable', () => {
        expect(RACES.row_lock.steps.some((step) => step.buyers.B.kind === 'waiting')).toBe(true);
        expect(RACES.serializable.steps.some((step) => step.buyers.B.kind === 'aborted')).toBe(
            true
        );
    });
});

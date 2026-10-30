import { useState } from 'react';

import { REPO_URL } from './Portfolio.js';
import { type Buyer, type BuyerState, RACES, type Strategy } from './race-script.js';

const STRATEGIES: readonly { id: Strategy; name: string; summary: string }[] = [
    { id: 'none', name: 'No protection', summary: 'Kept in the service to prove the bug is real.' },
    {
        id: 'row_lock',
        name: 'Row lock',
        summary: 'The default. Orders for a product wait in line.',
    },
    {
        id: 'serializable',
        name: 'Serializable',
        summary: 'Nothing waits. Postgres aborts the loser, and the store retries it.',
    },
];

const describeState = (state: BuyerState): string => {
    switch (state.kind) {
        case 'idle':
            return 'Has not started';
        case 'reading':
            return `Sees ${state.sees} available`;
        case 'waiting':
            return 'Waiting for the lock';
        case 'committed':
            return 'Order placed';
        case 'aborted':
            return 'Aborted by Postgres';
        case 'refused':
            return state.rejection.kind === 'insufficient_salable'
                ? `Refused: ${state.rejection.available} available`
                : 'Refused';
    }
};

/**
 * Two buyers, one unit, one step at a time, under each strategy.
 *
 * Needs no database, so it renders while Postgres is still starting.
 */
export const Race = () => {
    const [strategy, setStrategy] = useState<Strategy>('none');
    const [index, setIndex] = useState(0);
    const race = RACES[strategy];
    const step = race.steps[index];
    const finished = index === race.steps.length - 1;

    const choose = (next: Strategy) => {
        setStrategy(next);
        setIndex(0);
    };

    if (!step) return null;

    return (
        <section className="race card" id="race" tabIndex={-1} aria-labelledby="race-title">
            <h2 id="race-title">Two buyers, one unit</h2>
            <p className="hint">
                The whole service exists for this moment. Pick a strategy and step through what each
                buyer's transaction does. Every decision is made by the service's own code, from
                exactly what that buyer read.
            </p>

            <div className="tabs" role="group" aria-label="Concurrency strategy">
                {STRATEGIES.map((option) => (
                    <button
                        key={option.id}
                        type="button"
                        aria-pressed={option.id === strategy}
                        onClick={() => choose(option.id)}
                    >
                        {option.name}
                    </button>
                ))}
            </div>
            <p className="hint">{STRATEGIES.find((option) => option.id === strategy)?.summary}</p>

            <div className="lanes">
                {(['A', 'B'] as const satisfies readonly Buyer[]).map((buyer) => (
                    <div
                        key={buyer}
                        className={`lane ${step.buyers[buyer].kind}${step.actor === buyer ? ' active' : ''}`}
                    >
                        <h3>Buyer {buyer}</h3>
                        <p>{describeState(step.buyers[buyer])}</p>
                    </div>
                ))}
                <div className="lane ledger-lane">
                    <h3>The ledger</h3>
                    {step.ledger.length === 0 ? (
                        <p>No entries yet</p>
                    ) : (
                        <ul>
                            {step.ledger.map((entry, position) => (
                                <li key={position}>
                                    <code>
                                        {'orderId' in entry ? entry.orderId : ''} {entry.quantity}
                                    </code>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            <div className="step" aria-live="polite">
                <p className="counter">
                    Step {index + 1} of {race.steps.length}, buyer {step.actor}
                </p>
                <p>{step.says}</p>
                <pre>{step.sql}</pre>
            </div>

            {finished && (
                <p className={`verdict ${race.accepted > 1 ? 'refused' : 'ok'}`}>
                    {race.accepted > 1
                        ? `Oversold. ${race.accepted} orders were accepted for one unit, and available stock is now ${race.finalAvailable}.`
                        : 'Sold exactly once. One order was accepted and the other buyer was told nothing is left.'}
                </p>
            )}

            <div className="row">
                <button type="button" disabled={index === 0} onClick={() => setIndex(index - 1)}>
                    Back
                </button>
                <button type="button" disabled={finished} onClick={() => setIndex(index + 1)}>
                    Next step
                </button>
                <button type="button" disabled={index === 0} onClick={() => setIndex(0)}>
                    Start over
                </button>
            </div>

            <p className="hint footnote">
                Postgres in this page has a single connection, so this walks through the race rather
                than running it. The real race runs against Postgres in the{' '}
                <a href={`${REPO_URL}/blob/main/src/postgres/store/store.test.ts`}>test suite</a> on
                every change, twelve buyers at once, with a guard that fails if the unprotected
                strategy ever stops overselling.
            </p>
        </section>
    );
};

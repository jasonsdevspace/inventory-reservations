import { useState } from 'react';

import { withTenant } from '../../../src/postgres/pool/connection.js';
import { reconcileAll } from '../../../src/postgres/reconcile/reconcile.js';
import { DEMO_STOCK } from '../../../src/postgres/seed/demo-data.js';
import type { DemoDatabase } from '../db/boot.js';
import { Detail, type Report } from './Demo.js';

/**
 * Attempts a visitor can make to get round the rules, each answered by
 * Postgres itself. The messages shown are the database's own.
 */
interface Attempt {
    readonly title: string;
    readonly explains: string;
    readonly run: (demo: DemoDatabase, merchantId: string) => Promise<Report>;
}

/**
 * A refusal here is the rule holding, so it reads as a success. Only an
 * attempt that got through would be a problem.
 */
const refusal = async (work: Promise<unknown>, succeeded: string): Promise<Report> => {
    try {
        await work;
        return { tone: 'refused', text: succeeded };
    } catch (error) {
        return {
            tone: 'ok',
            text: `Postgres refused it: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
};

const ATTEMPTS: readonly Attempt[] = [
    {
        title: 'Edit a ledger entry as the service',
        explains:
            'The service connects as a role with no right to update or delete, so the history cannot be rewritten through it.',
        run: ({ app }) =>
            refusal(
                app.query('update reservations set quantity = -99'),
                'The update went through.'
            ),
    },
    {
        title: 'Edit it as the database owner',
        explains:
            'The owner has every privilege, so a trigger refuses instead. The fix for a mistake is a compensating entry.',
        run: ({ owner }) =>
            refusal(
                owner.query('update reservations set quantity = -99'),
                'The update went through.'
            ),
    },
    {
        title: 'Read stock without saying whose',
        explains:
            'Row level security reads the merchant from the transaction. A query that forgets to say gets nothing, not everything.',
        run: async ({ app }) => {
            const { rows } = await app.query<{ n: number }>('select count(*)::int as n from stock');
            const seen = rows[0]?.n ?? 0;
            return {
                tone: seen === 0 ? 'ok' : 'refused',
                text: `The query ran and saw ${seen} rows of stock, out of every merchant's.`,
            };
        },
    },
    {
        title: "Write another merchant's entry",
        explains:
            'Declared as one merchant, the service cannot write a row belonging to another, even with a hand-written query.',
        run: ({ app }, merchantId) =>
            refusal(
                withTenant(app, merchantId, (client) =>
                    client.query(
                        `insert into reservations (merchant_id, sku, order_id, quantity, reason)
                         values ($1, 'DEMO-1', 'intruder', -1, 'order_placed')`,
                        [merchantId === 'acme' ? 'globex' : 'acme']
                    )
                ),
                'The write went through.'
            ),
    },
];

export const RulesPanel = ({
    demo,
    merchantId,
    onChange,
}: {
    readonly demo: DemoDatabase;
    readonly merchantId: string;
    readonly onChange: () => Promise<void>;
}) => {
    const [answers, setAnswers] = useState<Record<string, Report>>({});
    const [broken, setBroken] = useState(false);
    const answer = (key: string, report: Report) =>
        setAnswers((current) => ({ ...current, [key]: report }));

    const reconcile = async (key: string) => {
        const findings = await reconcileAll(demo.app, demo.store, { policy: { kind: 'strict' } });
        answer(
            key,
            findings.length === 0
                ? { tone: 'ok', text: 'Reconciliation found nothing wrong.' }
                : {
                      tone: 'refused',
                      text: 'Reconciliation found a problem, and fixed nothing.',
                      detail: findings,
                  }
        );
    };

    // The merchant's last product, which the walkthrough above leaves alone.
    const target =
        DEMO_STOCK.filter((row) => row.merchantId === merchantId).at(-1)?.sku ?? 'DEMO-1';

    const writeByHand = async (quantity: number, reason: string) => {
        await demo.owner.query(
            `insert into reservations (merchant_id, sku, order_id, quantity, reason)
             values ($1, $2, 'by-hand', $3, $4)`,
            [merchantId, target, quantity, reason]
        );
        await onChange();
    };

    return (
        <section className="rules" aria-label="Try to break it">
            <h2>Try to break it</h2>
            <p className="hint">
                Each of these goes round the store and talks to Postgres directly, the way a bug or
                a hand-written query would.
            </p>
            <div className="attempts">
                {ATTEMPTS.map((attempt) => (
                    <article key={attempt.title}>
                        <h3>{attempt.title}</h3>
                        <p>{attempt.explains}</p>
                        <button
                            type="button"
                            onClick={() =>
                                void attempt
                                    .run(demo, merchantId)
                                    .then((report) => answer(attempt.title, report))
                            }
                        >
                            Try it
                        </button>
                        <Answer report={answers[attempt.title]} />
                    </article>
                ))}

                <article>
                    <h3>Break the ledger, then reconcile</h3>
                    <p>
                        As the owner, cancel five units of an order that never reserved any. The
                        reconciliation job finds it, and leaves the fix to a person, who records it
                        with a compensating entry.
                    </p>
                    <div className="row">
                        {broken ? (
                            <button
                                type="button"
                                onClick={() =>
                                    void writeByHand(-5, 'adjustment').then(() => {
                                        setBroken(false);
                                        return reconcile('reconcile');
                                    })
                                }
                            >
                                Fix it with a compensating entry
                            </button>
                        ) : (
                            <button
                                type="button"
                                onClick={() =>
                                    void writeByHand(5, 'order_canceled').then(() => {
                                        setBroken(true);
                                        answer('reconcile', {
                                            tone: 'info',
                                            text: `Wrote a cancellation for order by-hand on ${target}, which reserved nothing.`,
                                        });
                                    })
                                }
                            >
                                Write a bad entry
                            </button>
                        )}
                        <button type="button" onClick={() => void reconcile('reconcile')}>
                            Run reconciliation
                        </button>
                    </div>
                    <Answer report={answers.reconcile} />
                </article>
            </div>
        </section>
    );
};

const Answer = ({ report }: { readonly report: Report | undefined }) =>
    report ? (
        <div className={`answer ${report.tone}`} aria-live="polite">
            <p>{report.text}</p>
            {report.detail !== undefined && <Detail value={report.detail} />}
        </div>
    ) : null;

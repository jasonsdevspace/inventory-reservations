import type { LedgerEntry } from '../../../src/domain/types.js';

const time = (date: Date) =>
    date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * The ledger for one product, newest first, exactly as Postgres holds it.
 *
 * Nothing here is ever edited. Every action above adds rows, and the numbers
 * at the top are worked out from them on every read.
 */
export const Ledger = ({
    entries,
    now,
}: {
    readonly entries: readonly LedgerEntry[];
    readonly now: Date;
}) => (
    <section className="ledger" aria-label="Ledger">
        <h2>The ledger</h2>
        <p className="hint">
            Append only. Orders and holds add negative entries, and shipping, canceling or ending a
            hold adds the positive entry that closes them.
        </p>
        <div className="table">
            <table>
                <thead>
                    <tr>
                        <th scope="col">#</th>
                        <th scope="col">Reason</th>
                        <th scope="col">For</th>
                        <th scope="col">Quantity</th>
                        <th scope="col">Note</th>
                    </tr>
                </thead>
                <tbody>
                    {entries
                        .map((entry, index) => ({ entry, number: index + 1 }))
                        .reverse()
                        .map(({ entry, number }) => {
                            const hold = 'holdId' in entry ? entry : undefined;
                            const note = hold?.expiresAt
                                ? `${hold.expiresAt <= now ? 'expired' : 'expires'} ${time(hold.expiresAt)}`
                                : hold?.orderId
                                  ? `became ${hold.orderId}`
                                  : '';
                            return (
                                <tr key={number} className={entry.reason}>
                                    <td>{number}</td>
                                    <td>
                                        <code>{entry.reason}</code>
                                    </td>
                                    <td>{hold ? hold.holdId : entry.orderId}</td>
                                    <td className={entry.quantity < 0 ? 'minus' : 'plus'}>
                                        {entry.quantity > 0 ? `+${entry.quantity}` : entry.quantity}
                                    </td>
                                    <td>{note}</td>
                                </tr>
                            );
                        })}
                </tbody>
            </table>
        </div>
    </section>
);

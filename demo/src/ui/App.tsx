import { useEffect, useState } from 'react';

import { bootDemoDatabase, type DemoDatabase } from '../db/boot.js';
import { Benchmark } from './Benchmark.js';
import { Demo } from './Demo.js';
import { DemoFooter, PortfolioStrip, REPO_URL } from './Portfolio.js';
import { Race } from './Race.js';

type Boot =
    | { readonly state: 'starting' }
    | { readonly state: 'ready'; readonly demo: DemoDatabase }
    | { readonly state: 'failed'; readonly message: string };

/**
 * Started once per page load and never torn down, so React's development
 * double render does not boot a second database.
 */
let booting: Promise<DemoDatabase> | undefined;

/**
 * The page. The race and the benchmark need no database, so they render at
 * once, and only the live service waits for Postgres to start.
 */
export const App = () => {
    const [boot, setBoot] = useState<Boot>({ state: 'starting' });

    useEffect(() => {
        booting ??= bootDemoDatabase();
        booting.then(
            (demo) => setBoot({ state: 'ready', demo }),
            (error: unknown) =>
                setBoot({
                    state: 'failed',
                    message: error instanceof Error ? error.message : String(error),
                })
        );
    }, []);

    return (
        <>
            <PortfolioStrip />
            <main>
                <header className="intro">
                    <h1>inventory-reservations</h1>
                    <p className="lede">
                        An inventory ledger that keeps two customers from buying the last unit.
                        Stock is an append-only history rather than a number that gets changed, and
                        the moment two orders arrive together is handled by the database, not by
                        hope.
                    </p>
                    <p className="links">
                        <a href={`${REPO_URL}/tree/main/docs/decisions`}>Decision records</a>
                        <a href={`${REPO_URL}/blob/main/docs/benchmarks/results.md`}>Benchmark</a>
                    </p>
                </header>

                <Race />

                {boot.state === 'ready' ? (
                    <Demo demo={boot.demo} />
                ) : (
                    <section className="card boot" aria-live="polite">
                        <h2>Run the service</h2>
                        {boot.state === 'starting' ? (
                            <p className="hint">
                                Starting Postgres in your browser and applying the service's schema.
                                This downloads about 5 MB the first time.
                            </p>
                        ) : (
                            <p role="alert">
                                Postgres could not start in this browser: {boot.message}
                            </p>
                        )}
                    </section>
                )}

                <Benchmark />
            </main>
            <DemoFooter />
        </>
    );
};

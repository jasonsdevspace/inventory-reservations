import { useEffect, useRef, useState } from 'react';

import { bootDemoDatabase, type DemoDatabase } from '../db/boot.js';
import { Benchmark } from './Benchmark.js';
import { Demo } from './Demo.js';
import { ABOUT_URL, DemoFooter, PortfolioStrip, REPO_URL } from './Portfolio.js';
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
 * A link from the explainer names a section. The browser scrolls to it on
 * arrival when it is there, and does nothing when it only renders once
 * Postgres is up. So a section that was missing on arrival is scrolled to
 * and focused when it appears, unless the reader has scrolled since, in
 * which case the page is theirs and stays where they put it.
 */
const useLandOnSection = (ready: boolean) => {
    const pending = useRef(false);
    const moved = useRef(false);
    useEffect(() => {
        const id = window.location.hash.slice(1);
        if (!id) return undefined;
        pending.current = document.getElementById(id) === null;
        const onScroll = () => {
            moved.current = true;
        };
        window.addEventListener('scroll', onScroll, { passive: true, once: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);
    useEffect(() => {
        if (!ready || !pending.current || moved.current) return;
        const target = document.getElementById(window.location.hash.slice(1));
        if (!target) return;
        pending.current = false;
        target.scrollIntoView();
        target.focus();
    }, [ready]);
};

/**
 * The page. The race and the benchmark need no database, so they render at
 * once, and only the live service waits for Postgres to start.
 */
export const App = () => {
    const [boot, setBoot] = useState<Boot>({ state: 'starting' });
    useLandOnSection(boot.state === 'ready');

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
                    <section className="card boot" id="live" tabIndex={-1} aria-live="polite">
                        <h2>Run the service</h2>
                        {boot.state === 'starting' ? (
                            <p className="hint">
                                Starting Postgres in your browser and applying the service's schema.
                                This downloads about 5 MB the first time. While it starts,{' '}
                                <a href={ABOUT_URL}>read how it works</a>.
                            </p>
                        ) : (
                            <p role="alert">
                                Postgres could not start in this browser: {boot.message}. The race
                                above and the benchmark below still work.
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

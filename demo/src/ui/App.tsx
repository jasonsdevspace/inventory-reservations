import { useEffect, useState } from 'react';
import { bootDemoDatabase, type DemoDatabase } from '../db/boot.js';
import { Demo } from './Demo.js';

type Boot =
    | { readonly state: 'starting' }
    | { readonly state: 'ready'; readonly demo: DemoDatabase }
    | { readonly state: 'failed'; readonly message: string };

/**
 * Starts Postgres in the page, then shows the demo.
 *
 * Started once per page load and never torn down, so React's development
 * double render does not boot a second database.
 */
let booting: Promise<DemoDatabase> | undefined;

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

    if (boot.state === 'ready') return <Demo demo={boot.demo} />;

    return (
        <main className="boot" aria-live="polite">
            <h1>inventory-reservations</h1>
            {boot.state === 'starting' ? (
                <p>
                    Starting Postgres in your browser and applying the service's schema. This
                    downloads about 5 MB the first time.
                </p>
            ) : (
                <p role="alert">Postgres could not start in this browser: {boot.message}</p>
            )}
        </main>
    );
};

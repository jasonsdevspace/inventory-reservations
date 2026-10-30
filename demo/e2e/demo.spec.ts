import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/*
 * A visit to the built demo.
 *
 * Nothing is mocked. The page starts Postgres in the browser, applies the
 * service's schema and seeds the demo data, and every order below is a
 * real transaction against it. The page is audited with axe as a visitor
 * sees it, once on arrival and again after it has been used.
 */

const audit = async (page: Page) => {
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
};

// The page is at the base URL itself, so the path is relative to it rather
// than to the origin, which would drop the repository's path on Pages.
const visit = (page: Page) => page.goto('.');

// Postgres starts in the page, which takes a few seconds, and the live
// section replaces the starting card once it has. The product panel
// arrives with the first read of the inventory, a moment later, so it is
// the signal that the page is ready to be used.
const ready = async (page: Page) => {
    const live = page.getByRole('region', { name: 'Run the service' });
    await expect(live.getByRole('region', { name: 'Working with DEMO-1' })).toBeVisible({
        timeout: 60_000,
    });
    return live;
};

const stepToTheEnd = async (page: Page) => {
    const next = page.getByRole('button', { name: 'Next step' });
    // Bounded, so a walkthrough that never finishes fails here rather than
    // hanging the run. No strategy takes more than six steps.
    for (let step = 0; step < 8 && (await next.isEnabled()); step += 1) await next.click();
    await expect(next).toBeDisabled();
};

test('arrives on the page, says whose demo it is, and has no audit findings', async ({ page }) => {
    await visit(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('inventory-reservations');
    const strip = page.getByRole('navigation', { name: 'Portfolio' });
    await expect(strip.getByRole('link', { name: 'A demo by Jason Poteet' })).toBeVisible();
    await expect(strip.getByRole('link', { name: 'How it works' })).toBeVisible();
    await expect(strip.getByRole('link', { name: 'Source on GitHub' })).toBeVisible();
    await ready(page);
    await audit(page);
});

test('walks the race to its end: oversold without protection, sold once with a lock', async ({
    page,
}) => {
    await visit(page);
    const race = page.getByRole('region', { name: 'Two buyers, one unit' });
    await expect(race.getByText(/^Step 1 of \d+, buyer A$/)).toBeVisible();
    await expect(race.getByRole('button', { name: 'No protection' })).toHaveAttribute(
        'aria-pressed',
        'true'
    );

    await stepToTheEnd(page);
    await expect(race.getByText('Order placed')).toHaveCount(2);
    await expect(race).toContainText(
        'Oversold. 2 orders were accepted for one unit, and available stock is now -1.'
    );

    await race.getByRole('button', { name: 'Row lock' }).click();
    await expect(race.getByText(/^Step 1 of \d+, buyer A$/)).toBeVisible();
    await stepToTheEnd(page);
    await expect(race.getByText('Order placed')).toHaveCount(1);
    await expect(race.getByText('Refused: 0 available')).toBeVisible();
    await expect(race).toContainText(
        'Sold exactly once. One order was accepted and the other buyer was told nothing is left.'
    );

    await race.getByRole('button', { name: 'Start over' }).click();
    await expect(race.getByText(/^Step 1 of \d+, buyer A$/)).toBeVisible();
});

test('places an order for Acme, switches to Globex, and still has no audit findings', async ({
    page,
}) => {
    await visit(page);
    const live = await ready(page);
    await expect(live.getByRole('button', { name: 'Acme Supply Co' })).toHaveAttribute(
        'aria-pressed',
        'true'
    );
    const product = (name: RegExp) =>
        live.getByRole('region', { name: 'Products' }).getByRole('button', { name });
    await expect(product(/^DEMO-1 5 available of 5$/)).toHaveAttribute('aria-pressed', 'true');
    await expect(product(/^DEMO-COMMITTED 7 available of 10$/)).toBeVisible();

    // Acme's DEMO-1 starts with an empty ledger: the header row and nothing else.
    const ledger = live.getByRole('region', { name: 'Ledger' });
    await expect(ledger.getByRole('row')).toHaveCount(1);

    await live.getByRole('button', { name: 'Place an order' }).click();
    await expect(
        live.getByText('Order order-1 for 1: the store appended one entry.')
    ).toBeVisible();
    await expect(ledger.getByRole('row')).toHaveCount(2);
    const entry = ledger.getByRole('row', { name: /order-1/ });
    await expect(entry).toContainText('order_placed');
    await expect(entry.getByRole('cell', { name: '-1', exact: true })).toBeVisible();
    await expect(product(/^DEMO-1 4 available of 5$/)).toBeVisible();
    await expect(live.getByText('order-1 has 1 reserved')).toBeVisible();

    // The other merchant has its own DEMO-1, with its own stock and ledger.
    await live.getByRole('button', { name: 'Globex Corporation' }).click();
    await expect(live.getByRole('button', { name: 'Globex Corporation' })).toHaveAttribute(
        'aria-pressed',
        'true'
    );
    await expect(product(/^DEMO-1 11 available of 11$/)).toHaveAttribute('aria-pressed', 'true');
    await expect(product(/^DEMO-COMMITTED/)).toHaveCount(0);
    await expect(ledger.getByRole('row')).toHaveCount(1);
    await audit(page);

    // Back at Acme, the order is still on the ledger.
    await live.getByRole('button', { name: 'Acme Supply Co' }).click();
    await expect(product(/^DEMO-1 4 available of 5$/)).toBeVisible();
    await expect(ledger.getByRole('row', { name: /order-1/ })).toBeVisible();
});

test('the explainer reads without the database, audits clean, and lands a reader on a late section', async ({
    page,
}) => {
    await page.goto('./about/');
    await expect(page).toHaveTitle('How inventory-reservations works');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'How inventory-reservations works'
    );
    await expect(page.getByRole('navigation', { name: 'Portfolio' })).toContainText('How it works');
    const overflow = await page.evaluate<number>(
        'document.documentElement.scrollWidth - window.innerWidth'
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await audit(page);

    // The skip link is the first stop, and lands on the content.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await skip.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();

    // A story's link names a section that only exists once Postgres is up. The
    // page lands there when it appears, rather than leaving the reader at the top.
    await page.getByRole('link', { name: /find "Edit a ledger entry as the service"/ }).click();
    await expect(page).toHaveURL(/#rules$/);
    await ready(page);
    const rules = page.getByRole('region', { name: 'Try to break it' });
    await expect(rules).toBeInViewport();
    await expect(rules).toBeFocused();
});

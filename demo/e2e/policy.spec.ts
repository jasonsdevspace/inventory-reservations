import { expect, type Page, test } from '@playwright/test';

/*
 * Both pages carry a Content Security Policy that allows only their own origin, images as data
 * URLs, the one inline script, the WebAssembly Postgres runs as and a connection to Plausible.
 * Anything a page does that the policy refuses shows up as a violation, so the demo boots and
 * places an order and the explainer opens with every violation collected, and none is allowed.
 */

const watch = async (page: Page): Promise<string[]> => {
    const refused: string[] = [];
    page.on('console', (message) => {
        if (/Content Security Policy/i.test(message.text())) refused.push(message.text());
    });
    await page.addInitScript(`
        document.addEventListener('securitypolicyviolation', (event) => {
            console.error(
                'Content Security Policy refused ' + event.violatedDirective + ': ' + event.blockedURI
            );
        });
    `);
    return refused;
};

test('the demo and the explainer run within their policy', async ({ page }) => {
    const refused = await watch(page);

    await page.goto('.');
    const policy = page.locator('meta[http-equiv="Content-Security-Policy"]');
    await expect(policy).toHaveAttribute(
        'content',
        /script-src 'self' 'wasm-unsafe-eval' 'sha256-/
    );
    // The page may connect to Plausible for the visit counts, and to no other origin.
    await expect(policy).toHaveAttribute('content', /connect-src 'self' https:\/\/plausible\.io;/);
    const live = page.getByRole('region', { name: 'Run the service' });
    await expect(live.getByRole('region', { name: 'Working with DEMO-1' })).toBeVisible({
        timeout: 60_000,
    });
    await live.getByRole('button', { name: 'Place an order' }).click();
    await expect(live.getByText(/^Order order-1 for 1/)).toBeVisible();

    await page.goto('./about/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);

    expect(refused).toEqual([]);
});

test('hands the next page the site and nothing more of the address', async ({ page }) => {
    await page.goto('./?from=a-link#rules');
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'strict-origin');
    await page.evaluate(`(() => {
        const link = document.createElement('a');
        link.href = 'about/';
        document.body.append(link);
        link.click();
    })()`);
    await page.waitForURL(/about\/$/);
    const referrer = await page.evaluate<string>('document.referrer');
    expect(referrer).toBe(`${new URL(page.url()).origin}/`);
});

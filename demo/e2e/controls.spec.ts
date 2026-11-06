import { expect, type Page, test } from '@playwright/test';

/*
 * What a visitor needs to see of the controls. In both themes, each control's edge holds 3:1
 * against what it sits on and against its own fill, and a button that is off is drawn in colors
 * of its own rather than faded to whatever is behind it. In the light theme, each link and
 * control the keyboard reaches shows the accent ring.
 *
 * Measured in the page, as the browser draws it. The tests' own types have no DOM, so the
 * measuring is written as the page's script.
 */

const THEMES = ['light', 'dark'] as const;

/** The page in the theme given, as the portfolio's saved choice sets it. */
const visitIn = async (page: Page, theme: (typeof THEMES)[number], path = '.') => {
    await page.addInitScript((saved) => localStorage.setItem('theme', saved), theme);
    await page.goto(path);
};

/*
 * The contrast WCAG defines between two colors the browser has computed, and the color an
 * element sits on, found by walking up to the first ancestor with a background drawn.
 */
const MEASURE = `
    const channels = (color) => color.match(/[\\d.]+/g).slice(0, 3).map(Number);
    const luminance = (color) => {
        const [r, g, b] = channels(color).map((value) => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (high + 0.05) / (low + 0.05);
    };
    const behind = (element) => {
        for (let at = element.parentElement; at; at = at.parentElement) {
            const color = getComputedStyle(at).backgroundColor;
            if (!/rgba\\(.*,\\s*0\\)$/.test(color) && color !== 'transparent') return color;
        }
        return getComputedStyle(document.body).backgroundColor;
    };
`;

/** Each kind of control's weakest edge, against what it sits on or its own fill. */
const weakestEdges = (page: Page) =>
    page.evaluate<Record<string, number>>(`(() => {
        ${MEASURE}
        const weakest = {};
        for (const element of document.querySelectorAll('button, input, .skip, .tour-try')) {
            const style = getComputedStyle(element);
            if (style.display === 'none' || element.disabled) continue;
            const kind = element.className ? '.' + element.className.split(' ')[0] : '';
            const name = element.tagName.toLowerCase() + kind;
            const edge = Math.min(
                contrast(style.borderTopColor, behind(element)),
                contrast(style.borderTopColor, style.backgroundColor)
            );
            weakest[name] = Math.min(weakest[name] ?? Infinity, Math.round(edge * 100) / 100);
        }
        return weakest;
    })()`);

for (const theme of THEMES) {
    test(`draws every button's and field's edge at 3:1 or more in the ${theme} theme`, async ({
        page,
    }) => {
        await visitIn(page, theme);
        await expect(
            page.getByRole('region', { name: 'Run the service' }).getByRole('region', {
                name: 'Working with DEMO-1',
            })
        ).toBeVisible({ timeout: 60_000 });
        const demo = await weakestEdges(page);
        // The explainer's button to open the demo is a link drawn as a button.
        await page.goto('./about/');
        const about = await weakestEdges(page);
        expect(about).toHaveProperty(['a.tour-try']);
        const weak = Object.entries({ ...demo, ...about }).filter(([, edge]) => edge < 3);
        expect(weak).toEqual([]);
    });

    test(`draws a button that is off in its own colors in the ${theme} theme`, async ({ page }) => {
        await visitIn(page, theme);
        const race = page.getByRole('region', { name: 'Two buyers, one unit' });
        const next = race.getByRole('button', { name: 'Next step' });
        for (let step = 0; step < 8 && (await next.isEnabled()); step += 1) await next.click();
        await expect(next).toBeDisabled();
        const off = await page.evaluate<
            { label: string; opacity: string; text: number }[]
        >(`(() => {
            ${MEASURE}
            return [...document.querySelectorAll('button:disabled')].map((button) => {
                const style = getComputedStyle(button);
                return {
                    label: button.textContent.trim(),
                    opacity: style.opacity,
                    text: contrast(style.color, style.backgroundColor),
                };
            });
        })()`);
        const drawn = off.find(({ label }) => label === 'Next step');
        // Faded, its colors would be whatever shows through, so it is drawn whole, its
        // label still readable.
        expect(drawn?.opacity).toBe('1');
        expect(drawn?.text).toBeGreaterThanOrEqual(4.5);
    });
}

test('rings every link and control the keyboard reaches, in the accent color', async ({
    page,
    isMobile,
}) => {
    test.skip(isMobile, 'a phone has no keyboard focus to show');
    await visitIn(page, 'light');
    const accent = await page.evaluate<string>(
        `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`
    );
    const accentRgb = await page.evaluate<string>(`(() => {
        const probe = document.createElement('i');
        probe.style.color = ${JSON.stringify(accent)};
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
    })()`);
    // The skip link, then the strip's links, then the page's own links and the race's buttons.
    const seen = new Set<string>();
    for (let press = 0; press < 12; press += 1) {
        await page.keyboard.press('Tab');
        const ring = await page.evaluate<{ tag: string; style: string; color: string }>(`(() => {
            const element = document.activeElement;
            const style = getComputedStyle(element);
            return {
                tag: element.tagName.toLowerCase(),
                style: style.outlineStyle,
                color: style.outlineColor,
            };
        })()`);
        seen.add(ring.tag);
        expect(ring, `focus stop ${String(press + 1)}`).toEqual({
            tag: ring.tag,
            style: 'solid',
            color: accentRgb,
        });
    }
    expect([...seen].sort()).toEqual(['a', 'button']);
});

test('lets the keyboard skip past the strip to the demo', async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone has no keyboard focus to show');
    await visitIn(page, 'light');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await skip.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
});

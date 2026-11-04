import { afterEach, describe, expect, it, vi } from 'vitest';

const init = vi.fn();
vi.mock('@plausible-analytics/tracker', () => ({ init }));

const { startAnalytics, withoutQueries } = await import('./analytics.js');

afterEach(() => {
    init.mockClear();
    vi.unstubAllGlobals();
});

describe('counting visits', () => {
    it('counts the visit under the one site the domain has, links out included', () => {
        expect(startAnalytics(true)).toBe(true);
        expect(init).toHaveBeenCalledWith({
            domain: 'jasonsdevspace.com',
            outboundLinks: true,
            transformRequest: withoutQueries,
            bindToWindow: false,
            logging: false,
        });
    });

    it('counts nothing for a visitor whose browser sends Global Privacy Control', () => {
        vi.stubGlobal('navigator', { globalPrivacyControl: true });
        expect(startAnalytics()).toBe(false);
        expect(init).not.toHaveBeenCalled();
    });

    it('sends no search phrase, from the page or the page before it', () => {
        const sent = withoutQueries({
            n: 'pageview',
            u: 'https://jasonsdevspace.com/shelflens/?q=wool+jacket&sort=price#results',
            d: 'jasonsdevspace.com',
            r: 'https://jasonsdevspace.com/shelflens/?q=jacket',
        });
        expect(sent).toEqual({
            n: 'pageview',
            u: 'https://jasonsdevspace.com/shelflens/',
            d: 'jasonsdevspace.com',
            r: 'https://jasonsdevspace.com/shelflens/',
        });
        expect(JSON.stringify(sent)).not.toContain('jacket');
    });

    it('keeps a visit that came from nowhere as one', () => {
        const sent = withoutQueries({
            n: 'pageview',
            u: 'https://jasonsdevspace.com/',
            d: 'x',
            r: null,
        });
        expect(sent).toMatchObject({ r: null });
    });

    it('sends a link out by its path, without its query or fragment', () => {
        const sent = withoutQueries({
            n: 'Outbound Link: Click',
            u: 'https://jasonsdevspace.com/shelflens/?q=jacket',
            d: 'jasonsdevspace.com',
            p: { url: 'https://github.com/jasonsdevspace/shelflens?tab=readme#jacket' },
        });
        expect(sent?.p).toEqual({ url: 'https://github.com/jasonsdevspace/shelflens' });
        expect(JSON.stringify(sent)).not.toContain('jacket');
    });

    it('keeps a referrer that is no web address as it is, and sends none that is no address', () => {
        const from = (r: string) =>
            withoutQueries({ n: 'pageview', u: 'https://jasonsdevspace.com/', d: 'x', r })?.r;
        expect(from('android-app://com.google.android.gm/')).toBe(
            'android-app://com.google.android.gm/'
        );
        expect(from('android-app://com.example/?q=jacket#top')).toBe('android-app://com.example/');
        expect(from('not an address')).toBeNull();
    });

    it('keeps the tags a shared link carries, and nothing else of its query', () => {
        const sent = withoutQueries({
            n: 'pageview',
            u: 'https://jasonsdevspace.com/?q=jacket&utm_source=newsletter&utm_campaign=fall#top',
            d: 'jasonsdevspace.com',
        });
        expect(sent?.u).toBe('https://jasonsdevspace.com/?utm_source=newsletter&utm_campaign=fall');
    });

    it('sends no click on a link out whose address cannot be read', () => {
        const sent = withoutQueries({
            n: 'Outbound Link: Click',
            u: 'https://jasonsdevspace.com/',
            d: 'jasonsdevspace.com',
            p: { url: 'not an address' },
        });
        expect(sent).toBeNull();
    });

    it('sends nothing for a page whose own address cannot be read', () => {
        expect(withoutQueries({ n: 'pageview', u: 'not an address', d: 'x' })).toBeNull();
    });

    it('leaves the page as it was when the tracker cannot start', () => {
        init.mockImplementationOnce(() => {
            throw new Error('plausible.init() can only be called once');
        });
        expect(startAnalytics(true)).toBe(false);
    });
});

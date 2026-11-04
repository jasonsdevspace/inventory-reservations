import { init, type PlausibleRequestPayload } from '@plausible-analytics/tracker';

import { trackingAllowed } from './privacy.js';

/**
 * Counts visits to the demo's pages with Plausible, under the one Plausible
 * site the whole of jasonsdevspace.com counts under, so a visit from the
 * portfolio into the demo reads as one journey.
 *
 * Nothing is stored in the browser and no cookie is set. A visitor whose
 * browser sends Global Privacy Control is not counted at all. Only the path
 * of a page is sent, of the page before it and of a link out, never the
 * query or the fragment. A counter that cannot start leaves the page as it
 * was.
 *
 * The tracker leaves out pages on localhost and under an automated browser,
 * so the dev server, the end to end tests and the Lighthouse audits, which
 * open the built demo on localhost, are not counted. It also reports how long
 * a page was read and how far it was scrolled, sent with the page's path.
 */

/** The site in Plausible that every page on the domain counts under. */
const DOMAIN = 'jasonsdevspace.com';

/** An address as a URL, or nothing when it is no address at all. */
const parsed = (address: string): URL | undefined => {
    try {
        return new URL(address);
    } catch {
        return undefined;
    }
};

/**
 * An address without its query or fragment. A web address keeps its origin
 * and path. Another kind, such as the address an app on a phone gives as its
 * referrer, is cut at its query the same way, and text that is no address at
 * all is not sent.
 */
const pathOnly = (address: string): string | null => {
    const url = parsed(address);
    if (!url) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return address.split(/[?#]/)[0] ?? null;
    }
    return `${url.origin}${url.pathname}`;
};

/**
 * What is sent for a visit or a click, with each address cut back to its
 * path, or nothing when the page's own address cannot be read. It never
 * throws, since the tracker calls it from its own listeners.
 */
export const withoutQueries = (
    payload: PlausibleRequestPayload
): PlausibleRequestPayload | null => {
    const page = pathOnly(payload.u);
    if (page === null) return null;
    const link = payload.p?.['url'];
    return {
        ...payload,
        u: page,
        r: payload.r ? pathOnly(payload.r) : null,
        // A click on a link out carries the link's address among its properties.
        ...(payload.p &&
            typeof link === 'string' && { p: { ...payload.p, url: pathOnly(link) ?? '' } }),
    };
};

/** Starts counting, and says whether it did. */
export const startAnalytics = (allowed = trackingAllowed()): boolean => {
    if (!allowed) return false;
    try {
        // Links out, such as to the repository, are counted as clicks.
        init({
            domain: DOMAIN,
            outboundLinks: true,
            transformRequest: withoutQueries,
            // The tracker would otherwise set window.plausible, for Plausible's install check, and
            // warn in the console on every page it leaves out, such as each one the tests open.
            bindToWindow: false,
            logging: false,
        });
        return true;
    } catch {
        // A browser without what the tracker needs, or a second start, counts nothing.
        return false;
    }
};

import { createHash } from 'node:crypto';

/*
 * Kept apart from the rest of idempotency because it needs Node's crypto,
 * and only the HTTP server fingerprints requests. The store and the demo use
 * the rest without it.
 */

/**
 * A stable fingerprint of the request arguments.
 *
 * Key order in the input does not change the hash, so a client that serializes
 * its JSON differently between attempts is not treated as having asked
 * something new.
 */
export const hashRequest = (payload: Record<string, unknown>): string => {
    const stable = Object.keys(payload)
        .sort()
        .map((key) => `${key}=${JSON.stringify(payload[key])}`)
        .join('&');
    return createHash('sha256').update(stable).digest('hex');
};

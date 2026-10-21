import type { OversellPolicy } from '../domain/types.js';

/**
 * The oversell policy the server runs under.
 *
 * Policy is a business setting rather than a property of a request, so a
 * caller does not get to choose it. Letting a client pick would make
 * `backorder` a parameter anyone could send.
 *
 * Configured as `OVERSELL_POLICY`, one of `strict`, `threshold:N` or
 * `backorder:N`, and strict when unset.
 */
export const parsePolicy = (raw: string | undefined): OversellPolicy => {
    if (!raw || raw === 'strict') return { kind: 'strict' };

    const [kind, value] = raw.split(':');
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 0) {
        throw new Error(`OVERSELL_POLICY needs a whole, non-negative amount, got: ${raw}`);
    }
    if (kind === 'threshold') return { kind: 'threshold', holdBack: amount };
    if (kind === 'backorder') return { kind: 'backorder', limit: amount };
    throw new Error(`unknown OVERSELL_POLICY: ${raw}`);
};

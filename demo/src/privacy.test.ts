import { afterEach, describe, expect, it, vi } from 'vitest';

import { trackingAllowed } from './privacy.js';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('whether the visitor allows being counted', () => {
    it('reads Global Privacy Control from the browser', () => {
        vi.stubGlobal('navigator', { globalPrivacyControl: true });
        expect(trackingAllowed()).toBe(false);
        vi.stubGlobal('navigator', {});
        expect(trackingAllowed()).toBe(true);
    });
});

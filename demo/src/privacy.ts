/**
 * Whether the visitor allows being counted, which they do unless the browser
 * sends Global Privacy Control.
 */
export const trackingAllowed = (): boolean =>
    typeof navigator === 'undefined' ||
    !('globalPrivacyControl' in navigator && navigator.globalPrivacyControl === true);

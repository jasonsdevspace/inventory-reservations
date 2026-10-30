// The theme the portfolio saved, or the system's when nothing is saved,
// applied before the first paint so the page never flashes the other
// one, and again whenever the system changes or the portfolio saves a
// choice in another tab. Same origin, same key, so jasonsdevspace.com
// and this page switch together.
(function () {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const saved = function () {
        try {
            const s = localStorage.getItem('theme');
            return s === 'dark' || s === 'light' ? s : null;
        } catch {
            return null;
        }
    };
    const apply = function () {
        root.setAttribute('data-theme', saved() || (media.matches ? 'dark' : 'light'));
    };
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('storage', (event) => {
        if (event.key === null || event.key === 'theme') apply();
    });
})();

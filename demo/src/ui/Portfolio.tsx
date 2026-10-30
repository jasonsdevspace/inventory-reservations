/**
 * The two pieces of chrome that say whose demo this is: a strip above the
 * page and a footer below it.
 *
 * The strip answers the questions a visitor has on landing, who made this,
 * what it shows and where the code is, and nothing more. It is a navigation landmark
 * rather than a banner, so the page keeps one heading as its first read.
 * The footer is the exit after a long scroll and carries the rest.
 */

export const PORTFOLIO_URL = 'https://jasonsdevspace.com/';
export const PORTFOLIO_WORK_URL = 'https://jasonsdevspace.com/#work';
export const GITHUB_PROFILE_URL = 'https://github.com/jasonsdevspace';
export const REPO_URL = 'https://github.com/jasonsdevspace/inventory-reservations';
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
/** The explainer, beside the demo wherever the demo is served from. */
export const ABOUT_URL = './about/';

export const PortfolioStrip = () => (
    <nav className="portfolio" aria-label="Portfolio">
        <div className="portfolio-row">
            <a href={PORTFOLIO_WORK_URL}>A demo by Jason Poteet</a>
            <a href={ABOUT_URL}>How it works</a>
            <a href={REPO_URL}>Source on GitHub</a>
        </div>
    </nav>
);

export const DemoFooter = () => (
    <footer className="colophon">
        <p>
            inventory-reservations is a portfolio project by{' '}
            <a href={PORTFOLIO_URL}>Jason Poteet</a>. <a href={ABOUT_URL}>How it works</a>, in plain
            words. The <a href={REPO_URL}>source</a> and <a href={GITHUB_PROFILE_URL}>more work</a>{' '}
            are on GitHub, under the <a href={LICENSE_URL}>MIT license</a>.
        </p>
    </footer>
);

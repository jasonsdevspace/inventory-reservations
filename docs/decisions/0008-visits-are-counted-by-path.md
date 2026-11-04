# 8. Visits to the demo are counted by path, with Plausible, and not under Global Privacy Control

**Status:** accepted

## Context

The demo is part of a portfolio on jasonsdevspace.com, and whether anyone reads it is worth knowing:
which pages are opened, where a visitor came from, and whether a visit from the portfolio goes on
into the demo or out to the repository. The demo is static on GitHub Pages and held to a
Lighthouse audit with a budget for the script it ships. Its explainer promises that nothing a
visitor does in it leaves their machine.

## Options

The same as every site on the domain weighed, and ShelfLens's decision record 18 sets them out:
Google Analytics, which sets cookies and would need a visitor in the EU or the UK to agree first,
against Plausible, GoatCounter and Cloudflare Web Analytics, which set none. Plausible's tracker
from npm against the script tag it offers or a sender of our own. One counting site per project
against one for the domain.

## Decision

**Plausible's tracker from npm, under the one site for the domain,** for how long a page is read
and how far it is scrolled, and for a visit from the portfolio into the demo reading as one
journey. It is bundled with the demo's two pages and started from each one's entry, so nothing
loads from another origin.

**The path, never the query.** Every address sent, the page's, the one it came from and a link
out's, is cut back to its path. The demo keeps nothing in its address but the section a link opens,
and that is left out too.

**Not under Global Privacy Control.** The tracker is never started when the browser sends the
signal.

## Consequences

- The explainer now has a script, its visit counter, which is the one chunk it shares with the
  demo's page. It had none before.
- The tracker adds a few kilobytes of script, inside the Lighthouse budget, since the database
  client is most of the page.
- What a visitor does in the demo still never leaves their machine. The explainer now also says
  the site counts visits.
- A counter that cannot start, in a browser without what it needs, leaves the page as it was.
- Plausible leaves out pages on localhost and under an automated browser, so the dev server, the
  end to end tests and the Lighthouse audits count nothing.
- An ad blocker hides some visits, and GitHub Pages serves no proxy to route them through. The
  counts are a floor, not a census.

## How it is tested

- A unit test starts the tracker under the domain with links out counted, starts nothing when the
  browser sends Global Privacy Control, and leaves the page alone when the tracker throws.
- A unit test holds every address sent to its path: the page's, the one before it and a link out's.
- A unit test finds every page the demo serves and its entry, and finds each entry starting the
  counter, so a page added later is held to it too.

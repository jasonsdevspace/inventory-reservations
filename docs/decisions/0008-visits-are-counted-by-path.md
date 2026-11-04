# 8. Visits to the demo are counted by path, with Plausible, and not under Global Privacy Control

**Status:** accepted

## Context

The demo is part of a portfolio on jasonsdevspace.com, and whether anyone reads it is worth knowing:
which pages are opened, where a visitor came from, and whether a visit from the portfolio goes on
into the demo or out to the repository. The demo is static on GitHub Pages and held to a
Lighthouse audit with a budget for the script it ships. The explainer promises that nothing a
visitor does in the demo leaves their machine.

## Options

Every site on the domain weighed the same options, and
[ShelfLens's decision record 18](https://github.com/jasonsdevspace/shelflens/blob/main/docs/decisions/0018-visits-are-counted-by-path.md)
sets them out in full.

**Which service.** Google Analytics, which sets cookies, so a visitor in the EU or the UK would
first be asked to agree. Plausible, GoatCounter and Cloudflare Web Analytics, which set none.

**How it is loaded.** The script tag Plausible offers, from its origin. Its tracker from npm,
bundled with the page. Or a sender of our own.

**How many sites.** One per project, or one for the domain.

## Decision

**Plausible's tracker from npm, under the one site for the domain.** Plausible over GoatCounter
and Cloudflare Web Analytics for how long a page is read, how far it is scrolled and which links
out are followed. The tracker from npm over the script tag, so it is bundled with the demo's two
pages and started from each one's entry, and nothing loads from another origin. Over a sender of
our own, which would leave out the reading and the scrolling. One site for the domain over one per
project, so a visit from the portfolio into the demo reads as one journey.

**The path, never the query.** Every address sent, the page's, the one it came from and a link
out's, is cut back to its path. The demo keeps nothing in its address but the section a link opens,
and that is left out too.

**Not under Global Privacy Control.** The tracker is never started when the browser sends the
signal.

## Consequences

- The explainer now loads a bundled script, its visit counter, which is the one script chunk it
  shares with the demo's page. Its only script before was the inline one that sets the theme.
- The tracker adds about 3 KB of gzipped script, in a chunk of its own beside the demo's 221 KB, and
  the Lighthouse audit holds each page's script to 250 KB.
- Nothing a visitor enters or runs in the demo leaves their machine. What is sent is the visit,
  how long a page is read, how far it is scrolled and which links out are followed, and the
  explainer now says so.
- A counter that cannot start, in a browser without what it needs, leaves the page as it was, and
  an address it cannot read is not sent.
- Plausible leaves out pages on localhost and under an automated browser, so the dev server, the
  end to end tests and the Lighthouse audits count nothing.
- An ad blocker hides some visits, and GitHub Pages serves no proxy to route them through. The
  counts are a floor, not a census.

## How it is tested

- A unit test starts the tracker under the domain with links out counted, starts nothing when the
  browser sends Global Privacy Control, and leaves the page alone when the tracker throws.
- A unit test holds every address sent to its path: the page's, the one before it and a link out's,
  and sends nothing for a page whose address cannot be read.
- A unit test asks git for every page the demo serves, finds each one's entry, and finds each entry
  starting the counter, so a page added later is held to it too.

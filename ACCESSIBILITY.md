# Accessibility

The service in this repository is an API with nothing to use in a browser, so this statement
covers its demo page at
[jasonsdevspace.com/inventory-reservations](https://jasonsdevspace.com/inventory-reservations/) and
the page beside it on how it works. Both are built to meet the Web Content Accessibility
Guidelines, WCAG 2.2, at level AA.

## How it is checked

Each of these runs in CI on every pull request, against the demo built as it is published, and a
finding fails the pull request.

- **Automated audits.** axe audits the demo page once Postgres has started in it, again after an
  order is placed and the merchant switched, and the page on how it works, each in Chromium at a
  desktop size and a phone size.
- **Edges of controls.** Every button and field that is not unavailable on both pages, and the link
  drawn as a button that opens the demo, holds its edge at 3 to 1 against what it sits on and
  against its own fill, in the light theme and the dark one.
- **Unavailable buttons.** The "Next step" button in "Two buyers, one unit", when unavailable, is
  drawn at full strength rather than faded, with its label at 4.5 to 1 against its fill, in both
  themes.
- **Keyboard.** On both pages the first stop is a link that skips to the content and moves focus
  there. On the demo page, the first stops the keyboard reaches, from the skip link through the
  strip and the page's own links to the buttons of "Two buyers, one unit", each show a solid focus
  ring in the accent color.
- **Reflow.** The page on how it works does not scroll sideways at a desktop size or a phone size.
- **Lighthouse.** Both pages score a hundred for accessibility.

## Where it works

The pages are built for browsers that run ES2023, the build target in `demo/vite.config.ts`, and
the demo needs WebAssembly, since Postgres runs in the page as WebAssembly. Both pages follow the
system's light or dark setting unless the visitor has chosen a theme on jasonsdevspace.com.

## Known limitations

- The browser tests and Lighthouse run only in Chromium, so other browsers are covered by the build
  target alone, not by a test here.
- The full audits and the focus ring check run in the light theme. The dark theme is held by the
  checks on the edges of controls and on unavailable buttons.
- Postgres starts on the page's main thread once the page has painted, so for a few seconds the
  page can be slow to answer a key press or a tap, and the live part of the demo appears only once
  it has started.
- No test runs a screen reader. What one would announce is checked through the names, roles and
  states the browser tests find each control by.
- The criteria a tool cannot judge, such as whether a heading describes its section or a link's
  words say where it leads, are held by no test here.
- No test checks the demo page itself for sideways scrolling.
- No test here runs the pages in forced colors, where the system draws its own colors.
- In "Two buyers, one unit", the result at the last step is not announced to a screen reader, and
  focus can be lost on that step
  ([#49](https://github.com/jasonsdevspace/inventory-reservations/issues/49)).
- Under "Try to break it", a result can go unannounced, because its live region appears at the same
  moment as the result, and pressing again produces the same words, so nothing new is announced
  ([#51](https://github.com/jasonsdevspace/inventory-reservations/issues/51)).
- The headings that open and close a section of detail, and some links that stand alone, are about
  17 pixels tall, under a 24 pixel target
  ([#52](https://github.com/jasonsdevspace/inventory-reservations/issues/52)).

## Reporting a barrier

If something on the demo page or the page on how it works is hard or impossible to use, open an
issue with the
[bug template](https://github.com/jasonsdevspace/inventory-reservations/issues/new?template=3-bug.md).
Say what you were trying to do and on which page, and under "Where" the browser and any assistive
technology you use. The acceptance criteria and the size are for whoever fixes it, and can be left
empty. A maintainer adds the accessibility label, and it is handled as a bug. A barrier that is
also a security issue goes to the [security policy](SECURITY.md) instead.

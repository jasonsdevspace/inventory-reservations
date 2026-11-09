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
- **Lighthouse.** Both pages score a hundred for accessibility.
- **Edges of controls.** Every button and field on both pages, and the link drawn as a button that
  opens the demo, holds its edge at 3 to 1 against what it sits on and against its own fill, in the
  light theme and the dark one.
- **Buttons that are off.** A button that is off is drawn whole rather than faded, with its label at
  4.5 to 1 against its fill, in both themes.
- **Keyboard.** On both pages the first stop is a link that skips to the content and moves focus
  there. On the demo page, the links and buttons the keyboard reaches first each show a solid ring
  in the accent color.
- **Reflow.** The page on how it works does not scroll sideways at a desktop size or a phone size.

## Where it works

The pages are built for browsers that run ES2023, the build target in `demo/vite.config.ts`, and
the demo needs WebAssembly, which Postgres runs as in the page. Both pages follow the system's light
or dark setting unless the visitor has chosen a theme on jasonsdevspace.com.

## Known limitations

- The browser tests and Lighthouse run only in Chromium, so other browsers are held to the build
  target rather than by a test here.
- The full audits and the focus ring check run in the light theme. The dark theme is held by the
  checks on the edges of controls and on buttons that are off.
- Postgres starts on the page's main thread once the page has painted, so for a few seconds the
  page can be slow to answer a key press or a tap, and the live part of the demo appears only once
  it has started.
- No test runs a screen reader. What one would announce is checked through the roles, names and
  states the browser tests find each control by.
- The criteria a tool cannot judge, such as whether a heading describes its section or a link's
  words say where it leads, are held by no test here.
- [#49](https://github.com/jasonsdevspace/inventory-reservations/issues/49): the race's verdict is
  not announced to a screen reader, and focus can be lost on its last step.
- [#51](https://github.com/jasonsdevspace/inventory-reservations/issues/51): an answer in "Try to
  break it" can go unannounced, since its live region arrives with it and a repeat press says the
  same words.
- [#52](https://github.com/jasonsdevspace/inventory-reservations/issues/52): disclosure summaries
  and some links that stand alone are about 17 pixels tall, under a 24 pixel target.

## Reporting a barrier

If something on the demo page or the page on how it works is hard or impossible to use, open an
issue with the
[bug template](https://github.com/jasonsdevspace/inventory-reservations/issues/new?template=3-bug.md).
Say what you were trying to do, on which page, and the browser and any assistive technology you
use. The acceptance criteria and the size are for whoever fixes it, and can be left empty. It is
handled as a bug and labeled accessibility. A barrier that is also a security issue goes to the
[security policy](SECURITY.md) instead.

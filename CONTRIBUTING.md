# Contributing

inventory-reservations is a portfolio project, and it is held to the checks below whoever opens a
pull request. Everyone taking part follows the [code of
conduct](https://github.com/jasonsdevspace/.github/blob/main/CODE_OF_CONDUCT.md).

## Setting up and running the checks

[Dev setup](README.md#dev-setup) in the README says what to install and how to run the service. The
tests run against a real Postgres, so start the Compose database first and leave it running. The
lint reads the demo's types, so the demo's dependencies are installed too. Then run every check
CI's verify job runs:

```bash
docker compose up -d --build
npm ci
npm ci --prefix demo
npm run verify
```

`npm run verify` type-checks, lints, checks formatting and prose, checks that everything names the
Node version in `.nvmrc`, and runs the tests, against a test database the container creates beside
the one the service serves from.

A change to the demo in `demo/` also has to pass the demo's checks, which
[Check the demo](README.md#check-the-demo) lists with their commands. CI builds the demo as it is
published, runs its tests against Postgres in the page, visits it in Chromium on a desktop and a
phone with an axe audit on each visit, and audits both its pages with Lighthouse, where
accessibility has to score a hundred. CI also builds and scans the image the service ships as, as
[Check the image](README.md#check-the-image) describes.

## Writing

Every file is held to one style, which the prose check enforces: no em dashes, no semicolons
joining clauses, American spelling, no issue or pull request numbers in comments, and no notes about
the process, such as a list of what is left to do, in anything a reader sees. A commit message says
what changed and why in plain sentences, with no em dash or semicolon, and names the work rather
than whatever tool wrote it, which the commit message check enforces. Installing with `npm ci` sets
that check up as a hook on each commit, beside one that lints and formats the staged files, and CI
runs it on a pull request's title and body.

## Issues

Issues follow the templates under `.github/ISSUE_TEMPLATE`, for a piece of work, a parent issue
that holds several, and a bug, and a blank issue cannot be opened. A piece of work says what is
wrong or missing, what is already settled, and criteria a test or a look can check. A bug says what
happens, what should happen and how to see it.

## Pull requests

A pull request targets main and follows the template in `.github/pull_request_template.md`. Pull
requests are squashed, so the title becomes the commit on main, and the title and the body both
pass the commit message check. The body says what changed and why, with no counts, no checklist and
no notes to the reviewer, and ends with "Closes #N", or "Part of #N" when the issue has more to do.
Every check in CI passes before a pull request is merged, the browser tests and the Lighthouse
audit among them.

## Security and accessibility

Report a security issue privately, as the [security policy](SECURITY.md) says, not in a public
issue. Report a barrier to using the demo as the [accessibility statement](ACCESSIBILITY.md) says.

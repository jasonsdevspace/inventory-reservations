# 7. Publish only the image that was scanned

**Status:** accepted

## Context

The service ships as a container image, and the image is the thing an operator runs. Its contents
come from three places this repository does not write: the base images it is built on, the npm
packages in the lockfile, and the operating system packages inside the base images. Any of them
can carry a known vulnerability, and any of them can change without a line changing here, because
a tag such as `node:24-bookworm-slim` names whatever was pushed under it most recently.

Three questions follow. Which bytes does a build start from? Which findings stop a release, and
which are accepted, by whom and for how long? And is the image that was checked the image that
ships?

## Options

**A. Tags and a periodic audit.** Build from tags, run `npm audit` now and then, and fix what it
reports. Simple, and common. A build on Monday and a build on Tuesday can differ with nothing in
the repository recording why, and nothing stops a release between audits.

**B. Pin, scan in CI, and fail on everything.** Pin each base image by digest and fail the build on
any finding at all. Strict, and unworkable. A finding with no fix yet would block every merge until
an upstream release arrived, and the only way through would be to switch the scan off.

**C. Pin, scan in CI, fail on what can be fixed, and publish the scanned bytes.** Pin by digest,
fail on a high or critical finding that has a fix, list the rest without failing, accept a finding
only with a reason, a package and an expiry, and publish the exact image that was scanned.

## Decision

Option C.

**The bytes are pinned.** Each base image is named by digest, with its tag beside it for the
reader. Dependabot proposes a new digest as a pull request, which CI builds and scans like any
other change, so a base image moves only by review.

**A finding stops the build when someone can act on it.** A high or critical finding with a fix
available fails the image job, in the image or in either lockfile, dev dependencies included since
they run on every laptop and in CI. A finding with no fix yet is listed in its own step and does
not fail, because the fix is an upstream release, which Dependabot brings.

**An acceptance is narrow, explained and temporary.** The only way past a failing finding is an
entry in `.trivyignore.yaml`: one advisory, scoped to the one package its reason covers, with the
reason and a date. Trivy stops honoring it on that date. A check in CI warns thirty days ahead and
fails on an entry that no longer matches anything in its package, so the pull request that brings
the fix also removes the excuse. The same check runs weekly on a schedule against the published
image, where a warning fails the run, so a week with no pushes still hears about a date coming up.

**What ships is what was scanned.** On main the image is pushed once, by digest and untagged, with
a bill of materials and build provenance attached, and that pushed image is the one scanned. A
publish job tags that digest only after the tests, the demo and the scan have all passed. A release
scans the same digest again against the day's vulnerability data, gives it the version as a further
tag, and attaches the same bill of materials. Nothing is rebuilt along the way.

## Consequences

- The first scan found OpenSSL advisories in Debian's `libssl3` in the distroless runtime. Nothing
  in the image loads that library, because Node links its own OpenSSL, so they are accepted with
  that reason, scoped to `libssl3`, until the next distroless rebuild ships the fix.
- Every acceptance has a deadline someone has to meet. That is the point, and it is also work: an
  entry that lapses fails CI on main and stops publishing until it is fixed or reviewed.
- A pull request that bumps a base image can fail because it fixed something, when an acceptance
  stops matching. The message names the entry to remove.
- Moderate findings do not fail the build. The lint tooling carries one, in minimatch, whose fix
  is a major version ESLint does not support. The demo's Lighthouse tooling carried another, in
  glob, lifted to its fixed version by an override.
- An untagged image exists in the registry for every commit pushed to main, including any that
  failed a check. Only a tag says an image passed, which is why the release looks for the commit's
  tag rather than its digest.
- The release never rebuilds, so it cannot release a commit CI did not publish. A tag on a commit
  that was never the tip of a push to main is refused with that reason.

## How it is tested

- The image job runs on every pull request, so the pinning, both scans and the acceptance check run
  before any merge.
- The acceptance check has unit tests for each verdict: still matching, matching nothing, matching
  only another package, near its date, past it, an unreadable date and none.
- The acceptance file was checked against a real scan in both directions: scoped to `libssl3` it
  passes, and scoped to another package the same findings fail.
- The first release, 0.5.0, ran the release workflow end to end and tagged the digest CI had
  published for its commit.

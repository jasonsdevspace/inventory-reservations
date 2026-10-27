# 3. Idempotency keys: scope, storage and retention

**Status:** accepted

## Context

A client whose request times out cannot tell whether the order was placed. The request might have
failed, or it might have succeeded and the response been lost. The client's only safe move is to
retry, and without help, a retry of a successful order places a second one.

The same happens with webhooks. A payment provider that does not get a quick answer sends the same
event again, sometimes hours later, and a shipment recorded twice lowers physical stock twice.

## Options

**A. No keys, and natural idempotency where it exists.** Some commands are safe to repeat by
accident. Shipping a fully shipped order is refused, because nothing is outstanding. But placing an
order is not safe, and neither is shipping part of one.

**B. Client-supplied keys, checked before the work.** Store the key, then do the work. A crash
between the two leaves a key with no result, and every retry is refused forever.

**C. Client-supplied keys, claimed in the same transaction as the work.** The key and its result are
written together or not at all.

## Decision

Option C, with these rules.

- **Keys are scoped per merchant and per endpoint.** Two merchants choosing the same key cannot
  collide, and the same key on placing and on canceling are different keys. A global scope would
  let one merchant's retry return another merchant's answer.
- **The request is fingerprinted.** A key reused with different arguments is refused with 422,
  rather than replaying an answer to a question nobody asked. That case is always a client bug, and
  replaying would hide it as a data problem.
- **A duplicate of a request still running is told so.** It waits briefly on the key, and if the
  original has not finished it gets 409 `in_flight`, so it can retry rather than receive a
  half-finished answer.
- **Refusals are kept as well as successes.** If an order was refused for lack of stock, the retry
  gets the same refusal, not a fresh decision against newer stock. The client asked once and gets
  one answer. The exception is an unknown SKU, which describes the catalog at one moment, so it is
  never stored.
- **A replay is marked.** Every response to a write carries `Idempotency-Replayed`, so a client can tell a
  replay from a fresh result when the two look identical.
- **Keys are kept for 24 hours by default, then removed.** Removal is a scheduled job run as the
  owner, because the service's role cannot delete anything, and should not be able to so that a
  request handler can tidy up.

## Consequences

- **Retention has to outlast the longest retry.** A webhook replayed after its key was removed is
  treated as new. For placing an order that is a second order, and for a partial shipment it is a
  second partial shipment. `IDEMPOTENCY_RETENTION` should exceed the retry window of every caller,
  which for some payment providers is several days, not one.
- **Keys cost a row per write.** The table only holds the retention window, and the cleanup job
  keeps it there.
- **The key is the client's job.** A client that does not send one gets no protection, by design.
  Generating keys on the server would only protect requests that were never retried.

## How it is tested

- A retried order with the same key returns the original answer, marked as a replay, and places one
  order.
- A key reused with different arguments is refused.
- The same key on a different endpoint, and from a different merchant, is a different key.
- A client retrying into its own request while it is still running places one order.
- A retried hold conversion places one order, because holds use the same keys.

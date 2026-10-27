# 5. Reconciliation detects, and does not repair

**Status:** proposed

## Context

Everything in records 1 to 4 is about preventing a wrong ledger. Prevention is never complete. A
deployment runs with the wrong concurrency strategy, an operator writes an entry by hand, a cleanup
job is down for a week, or a bug ships. An inventory system has to be able to find out that its
ledger is wrong, not only try hard for it to be right.

An append-only ledger makes that possible, because every unit's history is still there to check.
A mutable quantity would only ever show the latest number.

## What counts as wrong

Each check is a rule that holds in every correct history, so any breach is a real finding.

- **An order released more than it reserved.** Its entries net above zero, so stock was shipped or
  canceled that it never held. The commands refuse this, so it means something bypassed them.
- **A conversion without its order.** Every `hold_converted` entry is paired with an `order_placed`
  entry for the same order and quantity. A conversion without one released a hold into nothing.
- **A hold that never ended.** A hold expired and was never given an ending, beyond the cleanup
  job's look-back window from record 4. It blocks no stock, because reads skip it, but its history
  is incomplete.
- **Stock committed past what exists.** Available stock below zero, beyond what the oversell policy
  allows. Under a correct strategy this cannot happen through the API, so it marks an oversell,
  a deployment running with `none`, or physical stock lowered beneath its commitments.

## Options

**A. Detect only.** Report each finding, with the merchant, SKU, order or hold, and the entries
behind it, and leave the fix to a person.

**B. Detect and repair.** Write the compensating entry each finding seems to call for.

## Decision

Option A, through `npm run reconcile`, behind the same guard as the other jobs.

Repair is rejected because the right compensation depends on facts the ledger does not hold. An
order that released too much might have shipped twice, which is a warehouse problem, or have had
a cancellation entered by mistake, which is a ledger problem. The two need opposite fixes. A tool
that picks one writes a second mistake on top of the first, and does it with the authority of an
automated process. Once a person knows which it was, the fix is an ordinary compensating entry,
visible in the history like any other.

- **It runs with the service's own role**, reading one merchant at a time under row level
  security, like the hold cleanup job. It writes nothing, so it needs no rights beyond reading.
- **It reports in a form a machine can read**, and exits with a failure status when it finds
  anything, so a scheduler can alert on it without parsing text.
- **It reads the whole history.** Unlike the cleanup job it has no look-back window, because old
  mistakes are exactly what it exists to find. It is meant to run daily, not every minute.

## Consequences

- A finding needs a person to act on it. That is the cost of not trusting an automated guess.
- The checks are only as complete as the rules above. A mistake that leaves every rule intact,
  such as an order placed for the wrong customer, is outside what a ledger can know.

## How it will be tested

- One test per rule that writes the broken history directly as the owner, bypassing the commands,
  and asserts reconciliation reports it.
- A test that a correct history, including holds, conversions and partial shipments, reports
  nothing.
- A test that it writes nothing, whatever it finds.

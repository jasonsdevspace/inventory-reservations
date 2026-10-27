# Contention benchmark

Run `npm run bench` with the containers up to reproduce it. The raw results are in
[results.json](results.json). Absolute numbers depend on the machine, so what carries over is the
comparison between the strategies.

| Recorded   | Commit    | Machine                | Postgres | Node    |
| ---------- | --------- | ---------------------- | -------- | ------- |
| 2026-10-27 | `c25ca1f` | Apple M2 Max, 12 cores | 18.6     | v24.3.0 |

Each scenario places 600 single-unit orders through the store, as the service role.
It runs 3 times after an unmeasured warm-up, and the run with the median throughput is shown.
There is always enough stock, so an order that gave up was refused by the strategy, not by an empty shelf.
Latency is per order as the caller sees it, waiting and retries included.

## One unit, many buyers

Buyers race for a single unit of stock, over repeated trials.

| Strategy     | Buyers | Trials | Fewest accepted | Most accepted |
| ------------ | ------ | ------ | --------------- | ------------- |
| none         | 12     | 25     | 11              | 12            |
| row lock     | 12     | 25     | 1               | 1             |
| serializable | 12     | 25     | 1               | 1             |

## A hot product

Every buyer orders the same SKU, as in a flash sale.

| Buyers | Row lock orders/s | Row lock p99 ms | Serializable orders/s | Serializable p99 ms | Retries per order | Gave up |
| ------ | ----------------- | --------------- | --------------------- | ------------------- | ----------------- | ------- |
| 1      | 502               | 3.16            | 447                   | 3.65                | 0.00              | 0       |
| 2      | 744               | 6.02            | 427                   | 8.15                | 0.05              | 2       |
| 4      | 737               | 9.74            | 413                   | 192.88              | 0.15              | 4       |
| 8      | 716               | 17.55           | 435                   | 538.95              | 0.31              | 9       |
| 16     | 721               | 28.62           | 385                   | 612.58              | 0.54              | 19      |
| 32     | 705               | 56.29           | 321                   | 583.85              | 1.36              | 47      |

## No contention

Each buyer orders a different SKU, so nobody waits on anybody. This is the baseline cost of
each strategy when there is no race.

| Buyers | Row lock orders/s | Row lock p99 ms | Serializable orders/s | Serializable p99 ms | Retries per order | Gave up |
| ------ | ----------------- | --------------- | --------------------- | ------------------- | ----------------- | ------- |
| 1      | 473               | 3.54            | 510                   | 3.74                | 0.00              | 0       |
| 2      | 1119              | 4.19            | 691                   | 22.42               | 0.14              | 0       |
| 4      | 1987              | 2.52            | 815                   | 73.95               | 0.26              | 0       |
| 8      | 3090              | 4.28            | 722                   | 132.11              | 0.38              | 0       |
| 16     | 4075              | 6.22            | 761                   | 297.28              | 0.73              | 1       |
| 32     | 5141              | 8.46            | 718                   | 500.22              | 1.16              | 4       |

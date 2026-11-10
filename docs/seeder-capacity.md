# Seeder capacity on loopback

This is a **loopback measurement on one development machine**, made with the
content-load harness (`apps/cli/scripts/content-load.js`). The readers, the
seeder, the seed-ws listener and the local DHT all run in ONE Node process on
127.0.0.1, so the reader side competes with the seeder for the same CPU and
event loop. It shows where refusals start and which caps cause them; it is
**not a capacity promise** for a deployed seeder, where readers are remote,
links have real round trips and the host is different.

## Machine and session

- CPU: Apple M4 Pro, 12 cores (`sysctl -n machdep.cpu.brand_string`, `sysctl -n hw.ncpu`).
- Memory: 51539607552 bytes, 48 GiB (`sysctl -n hw.memsize`).
- Node v25.2.1 (`node --version`), commit 1053027c (`git rev-parse --short HEAD`).
- Date: 2026-11-10, 15:39 to 15:46 local time, the four runs back to back.
- Load: the machine was shared with other work. `uptime` right before each
  run gave a 1 minute load average of 6.56 (1 client), 12.06 (16), 11.60 (32)
  and 9.30 (64). Latencies at 16 clients and above carry that noise; the
  refusal counts come from fixed caps and do not.

## Commands

Every number below comes from one of these commands, run one at a time from
the repository root, never in parallel, each saved as JSON:

```sh
node apps/cli/scripts/content-load.js --clients 1  --duration-ms 30000 --json   # [c1]
node apps/cli/scripts/content-load.js --clients 16 --duration-ms 30000 --json   # [c16]
node apps/cli/scripts/content-load.js --clients 32 --duration-ms 30000 --json   # [c32]
node apps/cli/scripts/content-load.js --clients 64 --duration-ms 30000 --json   # [c64]
node --cpu-prof apps/cli/scripts/content-load.js --clients 32 --duration-ms 30000 --json   # [prof32]
```

Defaults everywhere: dataset 20x40, inventory 0, RTT 0, host 127.0.0.1, and
every seeder and listener cap at its default (maxExternal 32, MEDIA_RATE 64
per second with burst 128, MEDIA_MAX_IN_FLIGHT 16, INDEX_RATE 32 per second
with burst 64, INDEX_MAX_IN_FLIGHT 16). Each phone open is sync.start,
feed.read, profile.read, peek.read, notices.list, one GET /index/counts with
27 refs and 4 GET /media, repeated by every reader until the 30 s end.

## Results

Latencies in milliseconds. "1013" is a WebSocket closed by the seeder for
capacity (the maxExternal cap), "503" an HTTP refusal of the /media or /index
rate or in-flight cap, "timeout" an operation over its harness deadline.

### Per run

| Run | Opens | Peak external sockets | 1013 closes | Event loop p50 / p99 / max | Peak RSS MiB |
|---|---|---|---|---|---|
| [c1] | 781 | 2 | 0 | 11.19 / 20.25 / 29.67 | 1040 |
| [c16] | 925 | 32 | 3 | 13.69 / 54.1 / 155.84 | 2551 |
| [c32] | 538 | 32 | 189 | 13.81 / 48.37 / 163.45 | 3210 |
| [c64] | 463 | 32 | 228 | 14.5 / 61.11 / 151.26 | 4426 |

RSS includes every in-process reader node, so it grows with the client
count and says little about the seeder alone.

### p50 / p95 per operation, refusals

| Operation | [c1] p50 / p95 | [c16] p50 / p95 | [c32] p50 / p95 | [c64] p50 / p95 |
|---|---|---|---|---|
| sync.start | 20.45 / 21.83 | 81.57 / 139.43 | 205.51 / 3410.93 | 469.62 / 6638.31 |
| feed.read | 7.16 / 8.56 | 7.33 / 9.32 | 7.6 / 11.93 | 7.7 / 12.2 |
| profile.read | 0.58 / 0.83 | 0.61 / 0.93 | 0.62 / 0.94 | 0.62 / 0.99 |
| peek.read | 5.28 / 7.07 | 182.91 / 233.96 | 424.49 / 540.66 | 695.54 / 1080.35 |
| notices.list | 2.11 / 2.93 | 47.55 / 70.46 | 150.21 / 224.28 | 401.82 / 598.16 |
| index.counts | 0.5 / 0.74 | 26.67 / 45.46 | 109.69 / 172.01 | 350.56 / 656.4 |
| media | 0.33 / 0.52 | 42.01 / 69.45 | 139.55 / 218.19 | 391.4 / 628.84 |

| Refusals (count of ops) | [c1] | [c16] | [c32] | [c64] |
|---|---|---|---|---|
| peek.read 1013 | 0 of 781 | 0 of 925 | 45 of 538 | 54 of 463 |
| notices.list 1013 | 0 of 781 | 3 of 925 | 42 of 538 | 33 of 463 |
| sync.start timeout | 0 | 0 | 1 of 538 | 0 |
| media 503 | 1088 of 3124 | 1795 of 3700 | 268 of 2152 | 217 of 1852 |
| index.counts 503 | 0 | 0 | 0 | 0 |

## Where refusals start

- **1013 (maxExternal)**: external sockets reach the cap of 32 at 16 clients
  [c16] (peak 32, 3 notices.list refused) and stay pinned there at 32 and 64
  [c32] [c64], where peek.read and notices.list, the operations that open
  their own seeder links, are refused 8 to 12 percent of the time. These
  counts include the harness's authors: it keeps min(clients, 20) dataset
  authors connected to the same listener for the whole run
  (`apps/cli/scripts/content-load.js`, `keep`), and their sockets count as
  external. At 16 clients that is 16 authors plus 16 readers (peak 2 at one
  client: 1 author plus 1 reader), so the readers alone would sit near 16
  sockets there. Do not size `VARANDA_MAX_EXTERNAL` from the client count of
  these runs. The tail
  of sync.start (p95 3.4 s at 32, 6.6 s at 64) grows in the same runs, most
  likely from waiting on a slot; that is an inference, the harness does not
  split the wait out.
- **503 on /media (MEDIA_RATE or MEDIA_MAX_IN_FLIGHT)**: /media answers the
  same 503 when the rate bucket (64 per second, burst 128) or the 16
  responses in flight are exhausted, and the harness does not split the two.
  At ONE client [c1] it is the rate: a lone reader on loopback asks for about
  104 media GETs per second (3124 in 30 s). At 16 clients [c16] both the
  attempts (3700) and the 503s (1795) are highest. At 64 clients [c64] the
  attempts fall to about 62 per second (1852 in 30 s), under the rate, yet
  217 still get 503: with 64 readers more than 16 responses are in flight at
  once, so the in-flight cap refuses them.
- **/index (INDEX_RATE, INDEX_MAX_IN_FLIGHT)**: no refusal in any run. Each
  completed open asks one /index/counts, so the heaviest run, 16 clients
  [c16] with 925 opens in 30 s, asked for about 31 per second: just under
  the rate of 32 (burst 64), with almost no headroom. The 64-client run
  [c64] asked for about 15 per second.
- Throughput (opens in 30 s) peaks near 16 clients [c16] and falls at 32 and
  64 [c32] [c64], as refused links and slot waits take over.

## Internal costs

The CPU profile of the whole harness process at 32 clients [prof32] (58.6 s
of samples, setup included; profile kept outside the repository) shows:

- 39.5 percent idle: the single process was not CPU bound.
- About 4.4 percent of samples have seeder or listener code
  (`seeder.js`, `seed-ws.js`, `engagement-index.js`, `notices-net.js`) on the
  stack; about 33 percent have reader code (`packages/web-member`,
  `member-ops.js`, `feed.js`). Samples reached through an asynchronous
  storage callback have no caller and count in neither group.
- The hottest functions are reader side: the Hypercore bitfield built while a
  reader opens its cores (quickbit `DenseIndex`, about 7 percent self time,
  from `random-access-storage` callbacks) and `structuredClone` in
  `records.js` `cloneRecord` from the reader's `feed.js` and `sync.js` (about
  3 percent).
- `Seeder#indexCounts` and the engagement index `counts` are under 0.1
  percent: each call reads four counters per ref, with no scan to cache.

No seeder-side computation stood out: no repeated identical work per index
revision, no scan wider than its answer, no work after a client leaves that
showed in the profile. The refusals come from the caps above, so this run
changed no code. The latency growth of index.counts and media (cheap on the
seeder) with the client count tracks contention in the shared process and on
the shared machine, not seeder work.

## Caps an operator may raise

All are environment variables of the seeder process, `varanda seed`
(parsed in `apps/cli/lib/cli.js`, applied by `apps/cli/lib/commands/seed.js`);
`varanda-serve` does not read them. The defaults stay as they are.

| Cap | Variable | Default | What it protects |
|---|---|---|---|
| External sockets | `VARANDA_MAX_EXTERNAL` | half of the seeder's 64 connections, 32 | Swarm peers (other seeders, members over the DHT) are never starved by WebSocket readers; beyond it a reader gets 1013 and retries. |
| Listener sockets | `VARANDA_MAX_SOCKETS` | 128 (external + /media + /index in flight + 64, never below 128) | File descriptors of the one TCP listener (WebSocket, /media, /index, Caddy keep-alive). |
| Media rate | `VARANDA_MEDIA_RATE`, `VARANDA_MEDIA_BURST` | 64 per second, burst 128 | Disk reads and upload bandwidth of /media; beyond it 503 with Retry-After 1. |
| Media in flight | `VARANDA_MEDIA_MAX_IN_FLIGHT` | 16 | Memory and open streams of concurrent media responses; slow readers cannot hold more. |
| Index rate | `VARANDA_INDEX_RATE`, `VARANDA_INDEX_BURST` | 32 per second, burst 64 | Event loop time spent answering /index. |
| Index in flight | `VARANDA_INDEX_MAX_IN_FLIGHT` | 16 | Concurrent /index answers held open. |

Raising maxExternal is the lever for the 1013 refusals seen here; it trades
room for swarm peers and memory per link. Raising the media rate trades disk
and bandwidth. Measure on the target host before raising either: these
loopback numbers do not transfer.

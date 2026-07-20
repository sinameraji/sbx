# Benchmarks

hotcell measured with [computesdk/benchmarks](https://github.com/computesdk/benchmarks) — the same open-source harness behind the public [sandbox provider leaderboard](https://www.computesdk.com/benchmarks/sandboxes/).

Run on 2026-07-19/20 against hotcell v0.1.10 (`main@d897b0c`). Provider numbers quoted for context are from that project's published run of 2026-07-17.

## Read this before quoting any number

**hotcell's numbers have no network in them; the leaderboard's do.** The public benchmark runs on a US CI runner and calls each provider's cloud API over the internet. hotcell is self-hosted, so the harness ran on the same machine as the daemon. That is the honest operating condition for a self-hosted sandbox — and it is *not* an apples-to-apples comparison with a hosted provider's number. Where this page compares, it says so explicitly.

Nothing here is an official leaderboard result. hotcell is not listed on that leaderboard (see [Getting officially listed](#getting-officially-listed)).

## The benchmarks

The suite measures **TTI (Time to Interactive)**: wall-clock from `create()` to the first successful `runCommand("node -v")`. Teardown is not timed. Scoring is `(0.60·median + 0.25·p95 + 0.15·p99)` scored against a 10-second ceiling, multiplied by success rate — 0–100, higher is better.

| Benchmark | What it does | What it exposes |
| --- | --- | --- |
| [Sequential TTI](#sequential-tti) | 100 sandboxes, one at a time | Cold-start latency with no contention |
| [Staggered TTI](#staggered-tti) | 100 sandboxes launched 200 ms apart | Degradation as load ramps |
| [Burst TTI](#burst-tti) | 100 sandboxes created simultaneously | Behaviour under a thundering herd |
| [Warm-pool adopt](#warm-pool-adopt) | Create against a pre-booted pool | The floor when a microVM is already running |
| [sandbox-dax](#sandbox-dax-not-yet-run) | Clone + install + typecheck a real repo | Real dev-workload throughput — *not yet run* |

Hardware: **Mac** = M-series, 8 cores / 16 GB, Docker Desktop with an 8 GB VM. **GCP** = 8 vCPU / 32 GB, nested virtualisation.

### Sequential TTI

100 iterations, one sandbox at a time. The leaderboard's headline metric.

| Driver | Host | Median | P95 | P99 | Success | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Container (Docker) | Mac | **210 ms** | 237 ms | 240 ms | 100/100 | 97.8 |
| Firecracker microVM (cold) | GCP | 2,559 ms | 2,568 ms | 2,573 ms | 100/100 | 74.4 |
| Apple VZ microVM (cold) | Mac | 2,618 ms | 2,712 ms | 2,724 ms | 100/100 | 73.4 |

The container driver's 210 ms is quick in absolute terms — the published leaderboard's mid-pack sits between 190 ms and 460 ms, with E2B at 373 ms and Modal at 458 ms, network included. If hotcell were hosted next to the benchmark's CI runners, a network allowance of roughly 20–80 ms would still leave it ahead of most of that pack. That allowance is an estimate, not a measurement: from the machine used for these runs, the round-trip to a cloud daemon was ~192 ms, which would erase the gap entirely. **Where you run it decides the number.**

Cold microVM boots are the opposite story: ~2.6 s is second-slowest against the published field, because every boot here is a real kernel boot with no pre-warming, while fast hosted providers serve from warm capacity. The fix is hotcell's own warm pool — see below.

Worth noting on its own: p95 lands 9 ms above the median on Firecracker and 94 ms on Apple VZ, across 100 cold boots. Boot time is highly predictable.

### Staggered TTI

100 sandboxes, one launched every 200 ms.

| Driver | Host | Concurrency | Median | P95 | Success | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Container | Mac | 100 | 300 ms | 347 ms | 100/100 | 96.8 |
| Apple VZ | Mac | 25 | 2,603 ms | 2,618 ms | 25/25 | 73.9 |
| Firecracker | GCP | 100 | 14,081 ms | 16,281 ms | 100/100 | 0 |

The container driver barely moves under a ramp (210 ms → 300 ms). Firecracker at 100 concurrent kernel boots on 8 vCPUs is CPU-bound — every sandbox came up, but the queue is the machine, not the driver. Apple VZ was capped at 25 because 100 microVMs exceed a 16 GB laptop; those rows are not comparable to a 100-wide run.

### Burst TTI

All sandboxes requested at once.

| Driver | Host | Concurrency | Median | P95 | Success | Score |
| --- | --- | --- | --- | --- | --- | --- |
| Container | Mac | 25 | 1,796 ms | 2,412 ms | 25/25 | 79.5 |
| Container | Mac | 100 | 10,115 ms | 12,778 ms | 100/100 | 0 |
| Apple VZ | Mac | 25 | 3,176 ms | 3,382 ms | 25/25 | 67.4 |
| Firecracker | GCP | 100 | 32,027 ms | 32,626 ms | 97/100 | 0 |

**This is hotcell's weakest result, and it is structural.** A 100-wide burst measures how much capacity sits behind an API. Hosted providers spread it across a fleet; a self-hosted daemon has one machine, and 100 simultaneous kernel boots serialise on its CPUs. The leaderboard's fastest burst numbers (tens to hundreds of milliseconds) are fleet numbers. If you need a 100-wide burst to be fast on one box, size a warm pool to cover it.

The three Firecracker failures were typed `422 agent never came up` — vsock handshake timeouts during the boot storm, not hangs or crashes.

One earlier container burst-100 run, with the daemon's default 256 MiB per-sandbox reservation, completed only **30/100**: admission control refused 70 creates with a fast, typed `503 host memory budget exhausted` rather than over-subscribing the box. Re-running with a smaller reservation completed 100/100. That refusal is the designed behaviour — hotcell will not OOM the host to look good on a burst — but it is a real number and it belongs here.

### Warm-pool adopt

hotcell can keep pre-booted microVMs on standby (`HOTCELL_VZ_WARM_POOL`, `HOTCELL_FC_WARM_POOL`) and adopt one on create instead of booting a kernel.

**Measured floor: 24 ms median** (10 iterations: 33, 28, 21, 23, 27, 19, 24, 16, 24, 23 ms; min 16, max 33). Apple VZ, all ten confirmed adopted from the pool.

Caveats, because this number is attractive and easy to misuse:

- It is **not an official TTI measurement**. It used hotcell's Alpine base image and an `echo` probe with a custom timer, not the harness's `node:22-slim` + `node -v`. `node -v` alone adds process-spawn cost.
- n = 10, localhost.
- Two known bugs currently stop warm pools from serving real workload images at all, so this floor is **not reachable in normal use today**:
  1. Setting a daemon-wide default memory limit (`HOTCELL_DEFAULT_MEMORY_MB`) makes every create ineligible for adoption — pool eligibility requires no explicit limits — so the sandbox cold-boots while a full pool sits idle.
  2. The pool image is pinned to the built-in Alpine base image, so a `node:22-slim` create can never adopt a spare.

Treat 24 ms as evidence that the adopt path is fast, not as a claimable TTI. Fixing the two bugs and re-measuring through the official harness is the open work.

### sandbox-dax (not yet run)

The suite's real-workload benchmark: inside one sandbox, download Bun, clone a repo, install dependencies, typecheck — seven timed phases. It needs outbound network from inside the guest, and hotcell's microVMs default to no NIC (egress goes through the gateway), so this has not been run. Worth doing: in the published 2026-07-17 run, only one of nineteen providers completed all seven phases.

## Summary

- **Cold-start latency for one sandbox is good** — 210 ms on the container driver, competitive with the hosted mid-pack even after a hosting allowance, provided you host it comparably.
- **Boot times are consistent** — microVM p95 within 9–94 ms of median over 100 cold boots.
- **Cold microVM boots are slow** — ~2.6 s, second-slowest against the published field, until warm pools cover real images.
- **Single-host burst is the weak spot** — one machine is one machine.
- **Failures are clean** — typed 4xx/5xx from admission control, no hangs; 11 of 13 runs at 100 % success, worst case 30/100 under deliberate memory pressure.

## Reproducing this

The harness talks to any endpoint, so a local daemon works:

```bash
git clone https://github.com/computesdk/benchmarks && cd benchmarks && npm install
```

Add a provider that wraps the hotcell SDK (`src/sandbox/hotcell-provider.ts`):

```ts
import { HotcellClient } from '@hotcell/sdk';

export function hotcell(opts: { endpoint: string; apiKey?: string; image?: string; driver?: string }) {
  const client = new HotcellClient({ endpoint: opts.endpoint, apiKey: opts.apiKey });
  return {
    sandbox: {
      create: async () => {
        const sb = await client.getSandbox(undefined, { image: opts.image, driver: opts.driver });
        return {
          sandboxId: sb.id,
          runCommand: async (cmd: string) => {
            const r = await sb.exec(cmd);
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          },
          destroy: () => sb.destroy(),
        };
      },
    },
  };
}
```

Register it in `src/sandbox/providers.ts`, then:

```bash
HOTCELL_IMAGE=node:22-slim hotcelld &          # the probe is `node -v` — the image needs Node
export HOTCELL_ENDPOINT=http://127.0.0.1:4750

npx tsx src/run.ts --provider hotcell --mode sequential --iterations 100
npx tsx src/run.ts --provider hotcell --mode staggered --concurrency 100 --stagger-delay 200
npx tsx src/run.ts --provider hotcell --mode burst      --concurrency 100
```

Pick concurrency your host can actually hold — the numbers above show what happens when you don't.

## Getting officially listed

hotcell does not appear on the public leaderboard. That requires a `@computesdk/<provider>` package merged into [computesdk/computesdk](https://github.com/computesdk/computesdk) (they publish it), a publicly reachable production endpoint, and credentials handed to the maintainers for the weekly run. Until then, everything here is self-reported and reproducible with the commands above.

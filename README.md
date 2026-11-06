# Understudy

An agent that learns the rhythm of the Walrus Memory relayer. Before each 15-minute window it writes down how many memories it expects the relayer to save. The Sui chain, read through Tatum, grades it afterwards. Walrus Memory holds each forecaster's record, and that record decides who to trust next time.

**Status: built for the Total Recall hackathon. The live agent started writing to Walrus Mainnet on 6 Nov 2026 at 05:58 UTC, with empty memory. The figures below come from a replay over real history, not from that live record; the dashboard shows the live record as it grows.**

## How it works

1. **Read.** Tatum's Sui gRPC gateway returns every `seal_encrypt_fence` call on the MemWal package. Each saved memory appears to make one such call, across a pool of 16 relayer wallets. That reading of the relayer's wallets is inferred from the chain and hasn't been officially confirmed.
2. **Forecast.** Four simple forecasters each estimate the next window: the last hour, the usual level for this time of day, the long-run average, and a blend.
3. **Recall.** The agent recalls recent grades from Walrus Memory and works out how much to trust each forecaster. Recent grades, and grades from the same time of day, count most.
4. **Commit.** It writes the forecast to Walrus before the window opens. A forecast that finishes writing late is marked and left out of the score.
5. **Grade.** When the window closes, it counts the calls on chain, removes its own writes, and saves how each forecaster did.
6. **Alert.** A count far outside the expected range raises an alert, with no hand-set thresholds.

Trust is rebuilt only from what memory returns, so a clean machine with the same Walrus account should carry on where the last one stopped.

## What the data says so far

A walk-forward replay over 5 days of real Mainnet activity (478 windows, averaging 77 memories per window):

| Forecast | Mean error (memories per window) |
|---|---|
| With memory (track records decide trust) | 25.8 |
| No memory (every forecaster trusted equally) | 27.0 |
| Half last hour, half usual, alone | 28.0 |
| Last hour alone | 28.2 |
| Long-run average alone | 29.7 |
| Usual for this time of day, alone | 33.7 |

Settings were chosen on the first half only. On the second half, memory scored 22.3 against 23.2 with no memory.

**Limits of this result:**

- The gain is modest (about 4%) and rests on a few days of data.
- The no-memory figure depends on which forecasters are in the pool. The "blend" forecaster is the average of two others, so equal trust leans toward them. Replacing it with "last window only" makes the no-memory average nearly as good as memory (26.0 against 25.9). What holds in every pool tested is that memory beats every single forecaster on its own.
- Other changes tried on the same history (ramping trust in slowly, weighting the last hour toward its newest window, damping the last hour after a spike) moved the error by 0.2 or less, so the model was left as it is.
- Relayer traffic is mostly noise at this scale. A fixed daily rhythm didn't beat the no-memory forecast at any window length from 15 minutes to 3 hours.
- The replay keeps grades in a plain array and doesn't go through Walrus recall. The live agent's results may differ.

## Run it

Requires Node 22.23.4 or newer in the 22 line. The repo pins it in `.nvmrc`.

```
npm install
npm run setup:protos
npm test
npm run history        # keyless, about 25 minutes for 7 days
npm run backtest
npm run agent:dry      # real chain counts, memories stay on this machine
npm run dashboard      # http://127.0.0.1:4173
```

**Hosted on Vercel.** `api/state.js` rebuilds the live dashboard from Walrus on each request: it recalls the newest forecasts, grades and lessons with a dashboard-only delegate key and joins them, with no local files involved. Responses are cached at the edge for five minutes so visitors can't use up the relayer rate limit the agent relies on. The replay comes from `public-data/replay.json` (`npm run export:replay`). Set `MEMWAL_DASHBOARD_KEY` and `MEMWAL_ACCOUNT_ID` in the Vercel project; the dashboard key can be revoked at memory.walrus.xyz without affecting the agent.

`npm run export:site` writes a static copy of the dashboard to `site/`, with a snapshot of the live record and the replay. The hosted dashboard is that copy, so it is only as fresh as its last published snapshot, and it says when that was.

`npm run agent:live` writes permanent, public-network memories to Walrus Mainnet and needs `MEMWAL_KEY` and `MEMWAL_ACCOUNT_ID` in `.env`. See `.env.example`.

## How it uses Tatum

All chain reads go through Tatum's Sui gRPC gateway (`GetServiceInfo` for the tip, `ListTransactions` with a Move-call filter for the relayer's calls). Reads start keyless and are spaced 13 seconds apart, under the anonymous limit of 5 requests a minute.

When `TATUM_API_KEY` is set and the gateway refuses a keyless call with a rate limit, that one call is retried with the key. Keyed reads are metered at 2 credits per transaction returned, as measured from the Tatum dashboard, and stop at 80,000 credits. `--use-key` makes every read keyed. Catch-up after downtime saves its progress after every page, so a refused call resumes rather than restarting.

## Running record

The live agent runs on one machine. It had no record between 07:03 and 15:48 UTC on 6 Nov while that machine was asleep, and windows in that gap have no forecast. From about 16:55 UTC on 6 Nov, keyless reads were being refused, so the key fallback has been carrying the reads.

## How it uses Walrus Memory

Forecasts, grades and lessons are saved with `remember` into three namespaces (`understudy-forecasts`, `understudy-grades`, `understudy-lessons`). Before each forecast, grades come back through `recall` with `sort: "recent"`; keeping them in their own namespace means the newest grades are always the candidates. On a machine with no local record, the agent also recalls its newest lesson to know which forecaster it last trusted.

Recalled memories are validated before they can affect trust: the trailer must parse, the window must be a finite time, and every forecaster's miss must be a finite, non-negative number. A malformed memory is ignored rather than allowed to turn the weights into NaN.

Each live forecast on the dashboard links to its Walrus blob. The blob's certification on Sui is the independent record that the number existed before its window opened.

Memories hold only public chain figures and the agent's own forecasts, with no personal data. They're permanent: the SDK has no delete, and the relayer's forget only removes the search index.

## Running it on Windows

`run-agent.ps1` and `run-publisher.ps1` are optional helpers for the machine that hosts the agent: they keep it running, restart it if it exits, hold off sleep while open, and republish the dashboard hourly. Everything else runs through the npm scripts above on any platform.

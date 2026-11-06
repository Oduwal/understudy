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

`npm run export:site` writes a static copy of the dashboard to `site/`, with a snapshot of the live record and the replay. The hosted dashboard is that copy, so it is only as fresh as its last published snapshot, and it says when that was.

`npm run agent:live` writes permanent, public-network memories to Walrus Mainnet and needs `MEMWAL_KEY` and `MEMWAL_ACCOUNT_ID` in `.env`. See `.env.example`.

## How it uses Tatum

All chain reads go through Tatum's Sui gRPC gateway. By default they're keyless, which Tatum allows at 5 requests a minute. With `--use-key`, reads use your API key and are metered at 2 credits per transaction returned, as measured from the dashboard, with a hard stop at 80,000 credits.

## How it uses Walrus Memory

Forecasts, grades and lessons are saved with `remember`, and grades come back through `recall`. Memories hold only public chain figures and the agent's own forecasts, with no personal data. The memories are permanent, so a namespace can't be fully erased.

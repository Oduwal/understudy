# Running the agent on Railway

The live agent runs on Railway as one always-on service with a volume mounted at `/app/data`
(chain activity cache, sync position, event log, credit meter). Only one copy of the agent may
run at a time, or forecasts would be written twice.

1. `railway init --name understudy`, `railway add --service agent`, then
   `railway volume add --mount-path /app/data`.
2. In the Railway dashboard, set `MEMWAL_KEY`, `MEMWAL_ACCOUNT_ID` and `TATUM_API_KEY` on the service.
3. Make an upload folder with `package.json`, `package-lock.json`, `src/`, `.tools/sui-apis/proto/`,
   `deploy/railway/`, and this folder's `Dockerfile` copied to the folder's root (Railway builds a
   root `Dockerfile`). No `.env`.
4. To move a running agent: stop the other copy, pack its state from `data/` with
   `tar -czf seed.tar.gz activity history/state.json agent/live agent/credits.json`, put
   `seed.tar.gz` in the upload folder's root, and run `railway up --service agent`.
   `start.sh` unpacks it only while the volume is empty, so later deploys never roll state back.

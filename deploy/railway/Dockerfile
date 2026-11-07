# The live agent on Railway. State (chain activity cache, sync position, event log, credit meter)
# lives on a volume mounted at /app/data, seeded once from a snapshot of the local machine's data/.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY .tools/sui-apis/proto ./.tools/sui-apis/proto
COPY deploy/railway/start.sh ./start.sh
# The state snapshot, present only in the one-off upload that moves the agent here (never in git).
# The glob lets the build succeed without it.
COPY seed.tar.g[z] ./
CMD ["sh", "start.sh"]

# Unpacks the state snapshot into the volume on first start, then runs the agent.
# The snapshot ships in the image as /app/seed.tar.gz (or can be uploaded to the volume as
# data/seed.tar.gz). It is only used while the volume has no state, so redeploys never roll back.
set -e
mkdir -p data
until [ -f data/activity/state.json ]; do
  for seed in data/seed.tar.gz seed.tar.gz; do
    if [ -f "$seed" ] && [ ! -f data/activity/state.json ]; then
      tar -xzf "$seed" -C data
      echo "seeded data/ from $seed"
    fi
  done
  if [ ! -f data/activity/state.json ]; then
    echo "waiting for a state snapshot (seed.tar.gz)"
    sleep 15
  fi
done
exec node src/agent.mjs --live

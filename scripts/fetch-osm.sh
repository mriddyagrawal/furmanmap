#!/usr/bin/env bash
# Pull the Furman campus extract from OpenStreetMap via Overpass.
# Writes data/campus.osm.json. Tries mirrors in order; Overpass instances go busy often.
set -euo pipefail

BBOX="${BBOX:-34.912,-82.457,34.938,-82.421}"   # S,W,N,E — campus + fringe
OUT="$(cd "$(dirname "$0")/.." && pwd)/data/campus.osm.json"

MIRRORS=(
  "https://overpass-api.de/api/interpreter"
  "https://overpass.kumi.systems/api/interpreter"
  "https://overpass.private.coffee/api/interpreter"
)

read -r -d '' QUERY <<QEOF || true
[out:json][timeout:180];
(
  way["building"]($BBOX);
  relation["building"]($BBOX);
  way["highway"]($BBOX);
  node["entrance"]($BBOX);
);
out body;
>;
out skel qt;
QEOF

ATTEMPTS="${ATTEMPTS:-3}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  for url in "${MIRRORS[@]}"; do
    echo "→ attempt $attempt: $url"
    tmp="$(mktemp)"
    if curl -sS -m 300 -G "$url" --data-urlencode "data=$QUERY" -o "$tmp" \
       && head -c 200 "$tmp" | grep -q '"elements"'; then
      mv "$tmp" "$OUT"
      echo "✓ wrote $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes, $(jq '.elements|length' "$OUT") elements)"
      exit 0
    fi
    reason="$(grep -o 'Error[^<]*' "$tmp" 2>/dev/null | head -1 || true)"
    echo "  …unavailable ${reason:-(timeout/no data)}"
    rm -f "$tmp"
    sleep $(( attempt * 5 ))
  done
done

echo "✗ all Overpass mirrors failed" >&2
exit 1

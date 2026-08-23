#!/usr/bin/env bash
# Pull the Furman campus extract from OpenStreetMap via Overpass.
# Writes data/campus.osm.json.
#
# Fetched in three small pieces rather than one big query, on purpose. The
# campus is tiny (~510 buildings, ~1100 highway ways) and each piece answers
# in seconds — the thing that actually fails is Overpass's dispatcher going
# busy for a window. A small request that fails fast and retries slips
# through those windows; one big request with a long timeout just hangs
# through them. Each piece retries independently and mirrors are rotated.
set -euo pipefail

BBOX="${BBOX:-34.912,-82.457,34.938,-82.421}"   # S,W,N,E — campus + fringe
ROUNDS="${ROUNDS:-6}"
PER_TRY_TIMEOUT="${PER_TRY_TIMEOUT:-90}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/data"
OUT="$DIR/campus.osm.json"

# OSM infrastructure filters bare-curl/python User-Agents. Identify the app
# and give a contact route — the repo URL, not a personal email.
UA="FurmanWayfinder/0.1 (agramr2@furman.edu; +https://github.com/mriddyagrawal/furmanmap)"

MIRRORS=(
  "https://overpass-api.de/api/interpreter"
  "https://overpass.kumi.systems/api/interpreter"
  "https://overpass.private.coffee/api/interpreter"
)

# name|query
#
# `out geom;` inlines each way's coordinates AND keeps its `nodes` id array.
# That is strictly better than `out body;>;out skel qt;`: no recursion, a far
# cheaper query for the dispatcher to serve, a much smaller response, and no
# separate skeleton copies of nodes to de-duplicate against tagged ones.
PARTS=(
  "buildings|(way[\"building\"]($BBOX);relation[\"building\"]($BBOX););out geom;"
  "highways|way[\"highway\"]($BBOX);out geom;"
  "entrances|node[\"entrance\"]($BBOX);out body;"
)

# Only 2 concurrent slots per IP. Ask the server when one is free rather
# than retrying blind.
wait_for_slot () {
  local st; st="$(curl -sS -m 15 -A "$UA" "${1%/interpreter}/status" 2>/dev/null || true)"
  local free; free="$(sed -n 's/.*\([0-9]\+\) slots available now.*/\1/p' <<< "$st" | head -1)"
  [ -n "$free" ] && echo "    (server reports $free slot(s) free)"
  return 0   # never non-zero: this is advisory, and `set -e` would abort the retry loop
}

fetch_part () {
  local name="$1" body="$2" dest="$3"
  local n_mirrors=${#MIRRORS[@]}
  for round in $(seq 1 "$ROUNDS"); do
    local url="${MIRRORS[$(( (round - 1) % n_mirrors ))]}"
    local tmp code; tmp="$(mktemp)"
    # POST, not a long GET: large queries in a URL are truncated or rejected.
    code="$(curl -sS -m "$PER_TRY_TIMEOUT" -X POST "$url" -A "$UA" \
              --data-urlencode "data=[out:json][timeout:180];$body" \
              -o "$tmp" -w '%{http_code}' 2>/dev/null || echo 000)"
    if [ "$code" = "200" ] && jq -e '.elements' "$tmp" >/dev/null 2>&1; then
      mv "$tmp" "$dest"
      echo "  ✓ $name: $(jq '.elements|length' "$dest") elements  (round $round, ${url#https://})"
      return 0
    fi
    # Overpass failures are verbose — surface the reason instead of guessing.
    local why; why="$(grep -o 'Error[^<]*' "$tmp" 2>/dev/null | head -1 | cut -c1-110)"
    echo "  · $name: round $round http=$code ${why:-no message} (${url#https://})"
    rm -f "$tmp"
    wait_for_slot "$url"
    sleep $(( round < 4 ? round * 4 : 15 ))
  done
  echo "  ✗ $name: giving up after $ROUNDS rounds" >&2
  return 1
}

echo "Fetching campus extract (bbox $BBOX)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

for part in "${PARTS[@]}"; do
  fetch_part "${part%%|*}" "${part#*|}" "$tmpdir/${part%%|*}.json"
done

# Merge. With `out geom` the parts no longer share skeleton node copies, but
# keep the tagged-copy preference: it is free, and it is the guard that would
# have caught entrances silently vanishing when the parts did overlap.
jq -s '{elements: (map(.elements) | add
        | group_by((.type // "") + "/" + ((.id // 0)|tostring))
        | map(max_by(if has("tags") then 1 else 0 end)))}' \
   "$tmpdir"/*.json > "$OUT"

echo "✓ wrote $OUT ($(jq '.elements|length' "$OUT") elements, $(( $(wc -c < "$OUT") / 1024 )) KB)"

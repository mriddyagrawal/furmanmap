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
# Last good response per part, so one flaky mirror cannot cost a whole refresh.
CACHE="$DIR/.parts"

# Never accept data older than what we already have.
#
# A "how far behind live OSM" threshold asks the wrong question: pull on a
# Monday for an edit made on Thursday and any honest answer looks stale. What
# actually matters is that a refresh never goes backwards. Every Overpass
# response states the age of the database that answered it, so a mirror serving
# older data than our committed snapshot is refused outright, whatever its age.
#
# The floor comes from data/meta.json, which is committed, so it survives a
# clean checkout and a CI runner with no history.
HAVE="$(jq -r '.osm_base // empty' "$DIR/meta.json" 2>/dev/null)"
[ -n "$HAVE" ] && echo "current snapshot is from $HAVE"

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
  # Furman's campus outline is already mapped. Matched by tag+name rather than
  # by a hardcoded id, so a re-draw upstream does not silently break the clip.
  "boundary|relation[\"amenity\"=\"university\"][\"name\"=\"Furman University\"]($BBOX);out geom;"
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
      # Mirrors do not all track OSM equally closely, and a stale one answers
      # perfectly well with old data. private.coffee once served a building
      # relation at version 3 from 2014 when OSM was on version 7, which
      # silently reverted a name fixed the day before and dropped two others.
      # Every Overpass response carries the age of the database that answered.
      base="$(jq -r '.osm3s.timestamp_osm_base // empty' "$tmp")"
      if [ -n "$base" ] && [ -n "$HAVE" ] && [[ "$base" < "$HAVE" ]]; then
        # ISO-8601 UTC sorts lexicographically, so a string compare is a date
        # compare and needs no date(1) — whose flags differ on macOS and Linux.
        echo "  · $name: ${url#https://} has $base, older than our $HAVE — refusing"
        rm -f "$tmp"; sleep 2; continue
      fi
      mv "$tmp" "$dest"
      mkdir -p "$CACHE" && cp "$dest" "$CACHE/$name.json"
      echo "  ✓ $name: $(jq '.elements|length' "$dest") elements  (round $round, ${url#https://}, osm ${base:-?})"
      return 0
    fi
    # Overpass failures are verbose — surface the reason instead of guessing.
    #
    # The `|| true` is load-bearing. Under `set -e` with pipefail, a grep that
    # matches nothing fails the pipeline, the assignment inherits that status,
    # and the script dies mid-retry. A 504 with an empty body did exactly that:
    # it aborted the whole refresh on round one, which is how the data quietly
    # stopped updating for two days while every run looked like it had tried.
    local why; why="$(grep -o 'Error[^<]*' "$tmp" 2>/dev/null | head -1 | cut -c1-110 || true)"
    echo "  · $name: round $round http=$code ${why:-no message} (${url#https://})"
    rm -f "$tmp"
    wait_for_slot "$url"
    sleep $(( round < 4 ? round * 4 : 15 ))
  done
  # Falling back to the last good copy rather than failing the whole refresh.
  #
  # The parts are fetched separately, and a single flaky one used to abort
  # everything: the boundary is the last of four, changes essentially never, and
  # a 429 on it silently threw away three successful fetches. Worse, `npm run
  # data` stops at the failed fetch and never rebuilds, so a refresh could
  # appear to run for days while the data stood still.
  if [ -f "$CACHE/$name.json" ]; then
    cp "$CACHE/$name.json" "$dest"
    echo "  ~ $name: all mirrors failed, reusing the copy from $(date -r "$CACHE/$name.json" '+%Y-%m-%d %H:%M')" >&2
    return 0
  fi
  echo "  ✗ $name: all mirrors failed and there is no previous copy" >&2
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
# The snapshot is only as fresh as its stalest part, so the recorded timestamp
# is the minimum across them.
# The snapshot is only as fresh as its stalest part, and a reused part is
# genuinely older — so the minimum is the honest number to record.
jq -s '{osm_base: ([.[].osm3s.timestamp_osm_base] | map(select(. != null)) | min),
        elements: (map(.elements) | add
        | group_by((.type // "") + "/" + ((.id // 0)|tostring))
        | map(max_by(if has("tags") then 1 else 0 end)))}' \
   "$tmpdir"/*.json > "$OUT"

echo "✓ wrote $OUT ($(jq '.elements|length' "$OUT") elements, $(( $(wc -c < "$OUT") / 1024 )) KB)"
echo "  snapshot is OSM as of $(jq -r '.osm_base // "unknown"' "$OUT")"

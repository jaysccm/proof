#!/usr/bin/env bash
# End-to-end check of proof.sh telemetry (JAY-120) with synthetic inputs: stub `gh` and `aws`, the repo's
# example walkthrough (prototype/data/sample-fix.json, a synthetic example) and a fake local OTLP endpoint.
# Needs bash, jq, node >= 18. No network, no model, no real PR.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"
PORT="${PROOF_TEST_PORT:-14318}"
cleanup() { curl -s -X POST "http://127.0.0.1:$PORT/quit" >/dev/null 2>&1 || true; rm -rf "$W"; }
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

mkdir -p "$W/bin"
jq -n --rawfile body <(jq -r '.decisions[].quote // empty' "$HERE/prototype/data/sample-fix.json") \
  '{number:4242,title:"SECRET TITLE",body:$body,headRefName:"secret-branch",baseRefName:"main",headRefOid:"1111111111111111111111111111111111111111",baseRefOid:"2222222222222222222222222222222222222222"}' > "$W/meta.json"
cat > "$W/bin/gh" <<'S'
#!/usr/bin/env bash
case "$1 $2" in "pr view") cat "$STUB_META" ;; "pr diff") : ;; *) exit 1 ;; esac
S
cat > "$W/bin/aws" <<'S'
#!/usr/bin/env bash
# last argument is the response file; STUB_AWS=fail leaves it empty, text writes non-JSON model output
case "${STUB_AWS:-fail}" in
  text) printf '%s' '{"content":[{"text":"I am sorry, here is prose, not JSON"}],"stop_reason":"end_turn"}' > "${@: -1}" ;;
  *) echo "AccessDenied" >&2; exit 254 ;;
esac
S
chmod +x "$W/bin/gh" "$W/bin/aws"
export PATH="$W/bin:$PATH" STUB_META="$W/meta.json"

OUTBODIES="$W/bodies.jsonl"; : > "$OUTBODIES"
node "$HERE/tests/collector.js" "$PORT" "$OUTBODIES" >/dev/null 2>&1 &
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done

run() { # name, expected exit, extra env..., -- args
  local name="$1" want="$2"; shift 2
  local out="$W/out-$name" rc=0
  env "$@" >"$out" 2>&1 || rc=$?
  [ "$rc" -eq "$want" ] || { cat "$out" >&2; fail "$name: exit $rc, expected $want"; }
}
latest() { tail -n 1 "$OUTBODIES"; }
count() { # metric label-string -> value in latest payload
  latest | jq -r --arg m "$1" --arg k "$2" '[.resourceMetrics[0].scopeMetrics[0].metrics[] | select(.name==$m) | (.sum // .histogram).dataPoints[]
    | select((.attributes | map(.value.stringValue) | join("|")) == $k) | (.asInt // .count)] | first // "absent"'
}
ENVON=(PROOF_TELEMETRY=1 "PROOF_TELEMETRY_ENDPOINT=http://127.0.0.1:$PORT" "PROOF_TELEMETRY_STATE=$W/state.json" PROOF_TELEMETRY_SYNC=1 PROOF_TELEMETRY_ENVIRONMENT=test)
BASE=("$HERE/proof.sh" 4242 --repo acme/secret-repo --out "$W/out")

# 1. off by default: nothing sent, nothing written
run off 0 "${BASE[@]}" --data "$HERE/prototype/data/sample-fix.json"
[ ! -s "$OUTBODIES" ] || fail "payload sent while off: $(cat "$OUTBODIES" | head -c 300)"
[ ! -e "$W/state.json" ] || fail "state written while off"
[ -s "$W/out/pr-4242.html" ] || fail "no artifact produced with telemetry off"

# 2. validated generation succeeds, with artifact checks and every stage timed
run success 0 "${ENVON[@]}" "${BASE[@]}" --data "$HERE/prototype/data/sample-fix.json"
[ "$(count proof_generations 'injected|success')" = 1 ] || fail "success not counted: $(latest)"
[ "$(count proof_artifact_checks 'validate|pass')" = 1 ] || fail "validate check"
[ "$(count proof_artifact_checks 'render|pass')" = 1 ] || fail "render check"
[ "$(count proof_artifact_checks 'regeneration_identical|pass')" = 1 ] || fail "regeneration check"
for s in gather generate ingest validate render total; do [ "$(count proof_generation_duration "$s|ok")" = 1 ] || fail "stage $s"; done

# 3. validation failure is a distinct outcome, not success
jq 'del(.decisions)' "$HERE/prototype/data/sample-fix.json" > "$W/broken.json"
run invalid 1 "${ENVON[@]}" "${BASE[@]}" --data "$W/broken.json"
[ "$(count proof_generations 'injected|validation_failed')" = 1 ] || fail "validation_failed: $(latest)"
[ "$(count proof_generations 'injected|success')" = 1 ] || fail "success total moved"
[ "$(count proof_artifact_checks 'validate|fail')" = 1 ] || fail "validate fail check"
[ "$(count proof_generation_duration 'validate|error')" = 1 ] || fail "failed stage timed"

# 4. backend failure and unusable model output
run backend 3 "${ENVON[@]}" STUB_AWS=fail "${BASE[@]}" --backend bedrock
[ "$(count proof_generations 'bedrock|backend_failure')" = 1 ] || fail "backend_failure: $(latest)"
run prose 3 "${ENVON[@]}" STUB_AWS=text "${BASE[@]}" --backend bedrock
[ "$(count proof_generations 'bedrock|invalid_output')" = 1 ] || fail "invalid_output: $(latest)"

# 5. nothing private on the wire or in the state file
for secret in "SECRET TITLE" acme secret-repo secret-branch 4242 1111111 "orders-service" github; do
  grep -q -i -- "$secret" "$OUTBODIES" "$W/state.json" && fail "private value leaked: $secret" || true
done

# 6. exporter down: same exit status as without telemetry, and not slowed past the send timeout
start=$(date +%s)
run down 0 PROOF_TELEMETRY=1 PROOF_TELEMETRY_ENDPOINT=http://127.0.0.1:9 "PROOF_TELEMETRY_STATE=$W/down.json" PROOF_TELEMETRY_SYNC=1 "${BASE[@]}" --data "$HERE/prototype/data/sample-fix.json"
[ $(( $(date +%s) - start )) -lt 30 ] || fail "exporter outage slowed the pipeline"
run down-async 0 PROOF_TELEMETRY=1 PROOF_TELEMETRY_ENDPOINT=http://127.0.0.1:9 "PROOF_TELEMETRY_STATE=$W/down.json" "${BASE[@]}" --data "$HERE/prototype/data/sample-fix.json"
echo "proof telemetry pipeline: OK"

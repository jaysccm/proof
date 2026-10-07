# Telemetry (optional, off by default)

`proof.sh` can report how generation runs behave to a private OpenTelemetry endpoint. Nothing is
sent unless **both** are set:

    PROOF_TELEMETRY=1
    PROOF_TELEMETRY_ENDPOINT=http://192.168.1.150:4318   # OTLP/HTTP base URL; loopback/LAN only

Public hosts are refused. `PROOF_TELEMETRY_ENVIRONMENT` is `production`, `development` (default) or
`test`. `PROOF_TELEMETRY_STATE` overrides the state file
(`${XDG_STATE_HOME:-~/.local/state}/proof/telemetry.json`, counts only).

There is no usage tracking of installed copies: with the variables unset the code path is a no-op
(no network, no file).

## What is recorded

One sample per single-PR run (`proof.sh <pr>`; the `stack` subcommand is not instrumented), sent after the
pipeline finishes, detached, with a 2 s timeout. It cannot change the exit status or delay the run.

| Series | Labels (bounded enums only) | Meaning |
| --- | --- | --- |
| `proof_generations_total` | `backend` = bedrock, opencode, injected (`--data`), none; `outcome` = success, backend_failure, invalid_output, validation_failed, render_failed, error | one terminal run |
| `proof_generation_duration_seconds` | `stage` = gather, generate, ingest, validate, render, total; `outcome` = ok, error | histogram; `total` is end to end, failed runs included |
| `proof_artifact_checks_total` | `check` = validate, render, regeneration_identical; `outcome` = pass, fail | artifact checks |
| `proof_last_success_timestamp_seconds` | none | last run whose artifact validated and rendered |

**Success means `validate.js` passed and the HTML rendered**, not that the generator returned.
`regeneration_identical` re-renders the same data and compares bytes (the safety net in `CLAUDE.md`); it is
only performed when telemetry is on. No PR numbers, titles, bodies, diffs, source, repo names or URLs are
recorded; anything outside the enums is dropped by `generator/telemetry.js`.

Totals are cumulative since the state file was created (the CLI is short-lived, and the backend drops OTLP
delta series). The dashboard is `dashboards/proof/` in `jaysccm/telemetry`.

## Tests

    node --test tests/telemetry.test.js     # exporter unit tests
    bash tests/telemetry-pipeline.sh        # proof.sh end to end with stub gh/aws and a fake local OTLP endpoint

Both use synthetic inputs only (`prototype/data/sample-fix.json`); no network, model or real PR.

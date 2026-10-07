#!/usr/bin/env node
/**
 * Opt-in generation metrics for proof.sh (JAY-120). Off unless PROOF_TELEMETRY=1 AND
 * PROOF_TELEMETRY_ENDPOINT (OTLP/HTTP base URL on a private address) are set.
 *
 *   node generator/telemetry.js record --backend bedrock --outcome success \
 *        --stage gather:0.4:ok --stage total:12.1:ok --check validate:pass
 *
 * Only bounded enums and durations are accepted; anything else is dropped, so PR numbers,
 * titles, bodies, diffs, repo names and URLs cannot reach a signal. Metrics are cumulative
 * (the CLI is short-lived and the backend drops OTLP delta series), kept as counts in a state
 * file. Never throws, never blocks longer than SEND_TIMEOUT_MS, exits 0 whatever happens.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const SEND_TIMEOUT_MS = 2000;
const ENUMS = {
  backend: ["bedrock", "opencode", "injected", "none"],
  outcome: ["success", "backend_failure", "invalid_output", "validation_failed", "render_failed", "error"],
  stage: ["gather", "generate", "ingest", "validate", "render", "total"],
  stageOutcome: ["ok", "error"],
  check: ["validate", "render", "regeneration_identical"],
  checkOutcome: ["pass", "fail"],
};
const BOUNDS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1200];
const ENVIRONMENTS = ["production", "development", "test"];

function privateEndpoint(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const kind = net.isIP(host);
  let ok;
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number);
    ok = a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  } else if (kind === 6) {
    const h = host.toLowerCase();
    ok = h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  } else {
    ok = !host.includes(".") || /\.(local|lan|internal)$/.test(host);
  }
  return ok ? url.replace(/\/+$/, "") : null;
}

function endpoint(env = process.env) {
  if (env.PROOF_TELEMETRY !== "1") return null;
  return privateEndpoint(env.PROOF_TELEMETRY_ENDPOINT || "");
}

function stateFile(env = process.env) {
  if (env.PROOF_TELEMETRY_STATE) return env.PROOF_TELEMETRY_STATE;
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "proof", "telemetry.json");
}

function zero(nowNs) {
  return { startNs: nowNs, generations: {}, checks: {}, duration: {}, lastSuccessS: null };
}

function bump(map, key, n = 1) { map[key] = (map[key] || 0) + n; }

/** Validate the CLI input against the enums; returns null if unusable. */
function parse(argv) {
  const out = { backend: null, outcome: null, stages: [], checks: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1] || "";
    if (k === "--backend" && ENUMS.backend.includes(v)) out.backend = v;
    else if (k === "--outcome" && ENUMS.outcome.includes(v)) out.outcome = v;
    else if (k === "--stage") {
      const [stage, secs, so] = v.split(":");
      const d = Number(secs);
      if (ENUMS.stage.includes(stage) && ENUMS.stageOutcome.includes(so) && Number.isFinite(d) && d >= 0)
        out.stages.push({ stage, outcome: so, seconds: d });
    } else if (k === "--check") {
      const [check, co] = v.split(":");
      if (ENUMS.check.includes(check) && ENUMS.checkOutcome.includes(co)) out.checks.push({ check, outcome: co });
    }
  }
  return out.backend && out.outcome ? out : null;
}

function apply(state, ev, nowS) {
  bump(state.generations, `${ev.backend}|${ev.outcome}`);
  for (const c of ev.checks) bump(state.checks, `${c.check}|${c.outcome}`);
  for (const s of ev.stages) {
    const key = `${s.stage}|${s.outcome}`;
    const h = state.duration[key] || (state.duration[key] = { count: 0, sum: 0, buckets: new Array(BOUNDS.length + 1).fill(0) });
    h.count += 1; h.sum += s.seconds;
    let i = BOUNDS.findIndex((b) => s.seconds <= b);
    h.buckets[i === -1 ? BOUNDS.length : i] += 1;
  }
  if (ev.outcome === "success") state.lastSuccessS = nowS;
}

/** Read-modify-write under a lock file (O_EXCL). Gives up quietly after ~1s. */
function update(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + ".lock";
  let fd = null;
  for (let i = 0; i < 40 && fd === null; i++) {
    try { fd = fs.openSync(lock, "wx"); } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock); } catch { /* raced */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  if (fd === null) return null;
  try {
    let state;
    try { state = JSON.parse(fs.readFileSync(file, "utf8")); if (!state.generations) throw 0; } catch { state = zero(Date.now() * 1e6); }
    fn(state);
    fs.writeFileSync(file + ".tmp", JSON.stringify(state));
    fs.renameSync(file + ".tmp", file);
    return state;
  } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch { /* ignore */ } }
}

const attr = (key, value) => ({ key, value: { stringValue: value } });

function buildPayload(state, nowNs, environment, version = "0.0.0") {
  const st = String(state.startNs), t = String(nowNs);
  const counter = (name, map, labels) => ({
    name, unit: "1", sum: {
      aggregationTemporality: 2, isMonotonic: true,
      dataPoints: Object.entries(map).map(([k, v]) => ({
        asInt: String(v), startTimeUnixNano: st, timeUnixNano: t,
        attributes: k.split("|").map((x, i) => attr(labels[i], x)),
      })),
    },
  });
  const metrics = [
    counter("proof_generations", state.generations, ["backend", "outcome"]),
    counter("proof_artifact_checks", state.checks, ["check", "outcome"]),
    {
      name: "proof_generation_duration", unit: "s", histogram: {
        aggregationTemporality: 2,
        dataPoints: Object.entries(state.duration).map(([k, h]) => ({
          startTimeUnixNano: st, timeUnixNano: t, count: String(h.count), sum: h.sum,
          bucketCounts: h.buckets.map(String), explicitBounds: BOUNDS,
          attributes: k.split("|").map((x, i) => attr(["stage", "outcome"][i], x)),
        })),
      },
    },
  ];
  if (state.lastSuccessS !== null)
    metrics.push({ name: "proof_last_success_timestamp", unit: "s", gauge: { dataPoints: [{ asDouble: state.lastSuccessS, timeUnixNano: t }] } });
  return {
    resourceMetrics: [{
      resource: { attributes: [attr("service.name", "proof"), attr("service.version", version), attr("deployment.environment.name", environment)] },
      scopeMetrics: [{ scope: { name: "proof.telemetry" }, metrics }],
    }],
  };
}

async function record(argv, env = process.env) {
  try {
    const base = endpoint(env);
    if (!base) return false;               // default: off, touches neither network nor disk
    const ev = parse(argv);
    if (!ev) return false;
    const nowS = Date.now() / 1000;
    const state = update(stateFile(env), (s) => apply(s, ev, nowS));
    if (!state) return false;
    const e = ENVIRONMENTS.includes(env.PROOF_TELEMETRY_ENVIRONMENT) ? env.PROOF_TELEMETRY_ENVIRONMENT : "development";
    let version = "0.0.0";
    try { version = require("../package.json").version; } catch { /* keep default */ }
    await fetch(base + "/v1/metrics", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(state, Date.now() * 1e6, e, version)),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }).then((r) => r.arrayBuffer());
    return true;
  } catch {
    return false;                           // exporter down/slow/misconfigured: drop silently
  }
}

if (require.main === module) {
  if (process.argv[2] === "record") record(process.argv.slice(3)).finally(() => process.exit(0));
  else { console.error("usage: node generator/telemetry.js record --backend B --outcome O [--stage s:secs:ok|error]... [--check c:pass|fail]..."); process.exit(0); }
}

module.exports = { privateEndpoint, endpoint, parse, apply, buildPayload, record, zero, ENUMS, BOUNDS };

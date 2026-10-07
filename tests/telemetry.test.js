// Unit tests for generator/telemetry.js (JAY-120). Run: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const t = require("../generator/telemetry.js");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "proof-tel-")); }
function collector(delayMs = 0) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => { bodies.push(JSON.parse(b)); setTimeout(() => res.end("{}"), delayMs); });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ bodies, url: `http://127.0.0.1:${server.address().port}`, close: () => server.closeAllConnections() || server.close() })));
}
const metrics = (body) => Object.fromEntries(body.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => [m.name, m]));
const labelled = (m) => Object.fromEntries((m.sum || m.histogram).dataPoints.map((d) =>
  [d.attributes.map((a) => a.value.stringValue).join("|"), d.asInt !== undefined ? Number(d.asInt) : Number(d.count)]));

test("private endpoints only", () => {
  for (const u of ["http://127.0.0.1:4318", "http://192.168.1.150:4318", "http://10.0.0.5", "http://172.20.0.1", "http://lgtm:4318", "http://bee.local:4318", "http://[::1]:4318"])
    assert.ok(t.privateEndpoint(u), u);
  for (const u of ["https://example.com", "http://8.8.8.8", "http://172.32.0.1", "ftp://10.0.0.1", "nope", "", "http://169.253.0.1"])
    assert.strictEqual(t.privateEndpoint(u), null, u);
});

test("default off: no state file, no network", async () => {
  const dir = tmp();
  const state = path.join(dir, "s.json");
  const c = await collector();
  try {
    // endpoint alone is not opt-in
    assert.strictEqual(await t.record(["--backend", "bedrock", "--outcome", "success"], { PROOF_TELEMETRY_ENDPOINT: c.url, PROOF_TELEMETRY_STATE: state }), false);
    assert.strictEqual(await t.record(["--backend", "bedrock", "--outcome", "success"], { PROOF_TELEMETRY: "1", PROOF_TELEMETRY_STATE: state }), false);
    assert.strictEqual(c.bodies.length, 0);
    assert.ok(!fs.existsSync(state));
  } finally { c.close(); }
});

test("parse accepts only bounded enums", () => {
  assert.strictEqual(t.parse(["--backend", "https://github.com/acme/secret", "--outcome", "success"]), null);
  assert.strictEqual(t.parse(["--backend", "bedrock", "--outcome", "PR #4242 failed"]), null);
  const ev = t.parse(["--backend", "bedrock", "--outcome", "success", "--stage", "pr-4242:1:ok", "--stage", "gather:1.5:ok", "--stage", "render:-3:ok",
    "--check", "secret-check:pass", "--check", "validate:pass"]);
  assert.deepStrictEqual(ev.stages, [{ stage: "gather", outcome: "ok", seconds: 1.5 }]);
  assert.deepStrictEqual(ev.checks, [{ check: "validate", outcome: "pass" }]);
});

test("records cumulative totals across invocations and keeps content out", async () => {
  const dir = tmp();
  const env = { PROOF_TELEMETRY: "1", PROOF_TELEMETRY_STATE: path.join(dir, "s.json"), PROOF_TELEMETRY_ENVIRONMENT: "test" };
  const c = await collector();
  env.PROOF_TELEMETRY_ENDPOINT = c.url;
  try {
    const ok = ["--backend", "bedrock", "--outcome", "success", "--stage", "generate:3.2:ok", "--stage", "total:4:ok",
      "--check", "validate:pass", "--check", "regeneration_identical:pass", "--repo", "acme/secret-repo", "--pr", "4242"];
    assert.strictEqual(await t.record(ok, env), true);
    assert.strictEqual(await t.record(["--backend", "bedrock", "--outcome", "validation_failed", "--stage", "validate:0.1:error", "--stage", "total:2:error", "--check", "validate:fail"], env), true);
    assert.strictEqual(c.bodies.length, 2);
    const m = metrics(c.bodies[1]);
    assert.deepStrictEqual(labelled(m.proof_generations), { "bedrock|success": 1, "bedrock|validation_failed": 1 });
    assert.deepStrictEqual(labelled(m.proof_artifact_checks), { "validate|pass": 1, "regeneration_identical|pass": 1, "validate|fail": 1 });
    assert.deepStrictEqual(labelled(m.proof_generation_duration), { "generate|ok": 1, "total|ok": 1, "validate|error": 1, "total|error": 1 });
    assert.ok(m.proof_last_success_timestamp.gauge.dataPoints[0].asDouble > 0);
    const wire = JSON.stringify(c.bodies) + fs.readFileSync(env.PROOF_TELEMETRY_STATE, "utf8");
    for (const secret of ["acme", "secret", "4242", "github.com"]) assert.ok(!wire.includes(secret), secret);
    const attrs = Object.fromEntries(c.bodies[0].resourceMetrics[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.strictEqual(attrs["service.name"], "proof");
    assert.strictEqual(attrs["deployment.environment.name"], "test");
  } finally { c.close(); }
});

test("exporter down or hanging never throws and is bounded", async () => {
  const dir = tmp();
  const base = { PROOF_TELEMETRY: "1", PROOF_TELEMETRY_STATE: path.join(dir, "s.json") };
  let started = Date.now();
  assert.strictEqual(await t.record(["--backend", "none", "--outcome", "error"], { ...base, PROOF_TELEMETRY_ENDPOINT: "http://127.0.0.1:9" }), false);
  assert.ok(Date.now() - started < 3000);
  const slow = await collector(10000);
  try {
    started = Date.now();
    assert.strictEqual(await t.record(["--backend", "none", "--outcome", "error"], { ...base, PROOF_TELEMETRY_ENDPOINT: slow.url }), false);
    assert.ok(Date.now() - started < 4000, "bounded by the send timeout");
  } finally { slow.close(); }
  // totals were still persisted, so the next successful export carries them
  assert.strictEqual(JSON.parse(fs.readFileSync(base.PROOF_TELEMETRY_STATE, "utf8")).generations["none|error"], 2);
});

test("corrupt state file is replaced", async () => {
  const dir = tmp();
  const state = path.join(dir, "s.json");
  fs.writeFileSync(state, "{broken");
  const c = await collector();
  try {
    assert.strictEqual(await t.record(["--backend", "opencode", "--outcome", "success"], { PROOF_TELEMETRY: "1", PROOF_TELEMETRY_ENDPOINT: c.url, PROOF_TELEMETRY_STATE: state }), true);
    assert.deepStrictEqual(labelled(metrics(c.bodies[0]).proof_generations), { "opencode|success": 1 });
  } finally { c.close(); }
});

// Fake private OTLP/HTTP endpoint for tests/telemetry-pipeline.sh: appends each POSTed body as one JSON line.
// POST /quit stops it; it also exits on its own after 120 s so a crashed test cannot leave it running.
const http = require("http");
const fs = require("fs");
const [port, out] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/quit") { res.end("bye"); server.close(); setTimeout(() => process.exit(0), 50); return; }
    if (req.method !== "POST") { res.end("ok"); return; }
    fs.appendFileSync(out, body.replace(/\n/g, "") + "\n");
    res.end("{}");
  });
});
server.listen(Number(port), "127.0.0.1");
setTimeout(() => process.exit(0), 120000).unref();

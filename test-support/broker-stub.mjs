// Stand-in for the Switchboard broker, contract 1, for testing the worker side only.
// Usage: node broker-stub.mjs [port] [mode]   mode: ok (default) | empty (503)
import http from "node:http";
import fs from "node:fs";

const port = Number(process.argv[2] || 8318);
const mode = process.argv[3] || "ok";
const log = process.env.STUB_LOG || "/tmp/broker-stub.log";
const KEY = "sb-key-stub";
let leases = 0;

function send(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
function note(line) { fs.appendFileSync(log, line + "\n"); }

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${KEY}`) { note(`401 ${req.method} ${req.url}`); return send(res, 401, { ok: false, reason: "bad-key" }); }
    if (req.url === "/v1/info") return send(res, 200, { ok: true, contract: 1, port, scope: "localhost-wsl", addresses: { localhost: `http://127.0.0.1:${port}` } });
    if (req.url === "/v1/lease" && (req.method === "POST" || req.method === "GET")) {
      note(`lease ${req.method} body=${body}`);
      if (mode === "empty") return send(res, 503, { ok: false, contract: 1, reason: "no-healthy-lane", retryAfterSeconds: 120, resetsAt: "2026-11-02T00:00:00.000Z" });
      leases++;
      return send(res, 200, {
        ok: true, contract: 1, leaseId: `lease_${leases}`, laneId: "lane-1", accountId: "claude-max-a", accountLabel: "Max Account A",
        provider: "claude", harness: "claude", binary: "claude", billing: "subscription",
        env: { CLAUDE_CODE_OAUTH_TOKEN: "stub-token-0123456789-0123456789" },
        tokenExpiresAt: "2027-11-01T00:00:00.000Z", resetsAt: "2026-11-01T19:00:00.000Z", headroom: { session: 72, weekly: 64 }, candidatesRemaining: 2,
      });
    }
    if (req.url === "/v1/lease/report" && req.method === "POST") { note(`report body=${body}`); return send(res, 200, { ok: true }); }
    send(res, 404, { ok: false, reason: "no-route" });
  });
}).listen(port, "127.0.0.1", () => note(`stub listening on ${port} mode=${mode}`));

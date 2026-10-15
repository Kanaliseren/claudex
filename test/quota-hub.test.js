import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { createQuotaHub } from "../src/quota-hub.js";

const now = new Date("2026-10-06T17:15:00Z");
const managementKey = "test-management-key";
const observed = (index, fraction, options = {}) => ({
  name: `claude-${index}.json`, auth_index: index, type: "claude", provider: "claude",
  quota: {
    observed_at: new Date(now.getTime() - 60_000).toISOString(),
    signals: {
      "Anthropic-Ratelimit-Unified-5h-Utilization": String(fraction),
      "Anthropic-Ratelimit-Unified-5h-Reset": String(now.getTime() / 1000 + 3600),
      "Anthropic-Ratelimit-Unified-7d-Utilization": "0.7",
      "Anthropic-Ratelimit-Unified-7d-Reset": String(now.getTime() / 1000 + 86400),
    },
  },
  ...options,
});

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, files = [observed("a", 0.13), observed("b", 0.07)], probeResponse, usageResponse) {
  const calls = [];
  const backend = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    calls.push({ path: request.url, body, authorization: request.headers.authorization });
    response.setHeader("X-Cpa-Version", "8.0.15");
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v0/management/auth-files") response.end(JSON.stringify({ files }));
    else if (request.url.endsWith("api-call")) {
      const payload = JSON.parse(body);
      if (payload.url === "https://api.anthropic.com/v1/messages") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        response.end(JSON.stringify(probeResponse ?? { status_code: 400, header: {}, body: '{"error":"probe unavailable"}' }));
        return;
      }
      response.end(JSON.stringify(payload.url.includes("/api/oauth/usage")
        ? usageResponse ?? { status_code: 429, header: { "Retry-After": ["0"] }, body: '{"error":{"message":"Rate limited. Please try again later."}}' }
        : payload.url.includes("/wham/usage")
          ? { status_code: 200, header: {}, body: JSON.stringify({ plan_type: "pro", rate_limit: payload.header["Chatgpt-Account-Id"] === "weekly-only"
            ? { primary_window: { used_percent: 22, limit_window_seconds: 604800, reset_at: now.getTime() / 1000 + 86400 }, secondary_window: null }
            : { primary_window: { used_percent: 12, reset_at: now.getTime() / 1000 + 3600 }, secondary_window: { used_percent: 79, reset_at: now.getTime() / 1000 + 86400 } } }) }
        : { status_code: 200, header: {}, body: '{"original":true}' }));
    } else response.end(body || '{"original":true}');
  });
  const upstreamUrl = await listen(t, backend);
  const server = createQuotaHub({ upstreamUrl, managementKey, now: () => now });
  const hub = await listen(t, server);
  const apiCall = (payload, key = managementKey, path = "/v8/management/requests/api-call") => fetch(hub + path, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const quota = (authIndex, extra = {}) => apiCall({ authIndex, method: "GET", url: "https://api.anthropic.com/api/oauth/usage", header: { Authorization: "Bearer $TOKEN$" }, ...extra });
  return { calls, hub, apiCall, quota, files, server };
}

test("successful full usage preserves Fable limits and other provider fields despite available model headers", async (t) => {
  const usage = { five_hour: { utilization: 17 }, seven_day: { utilization: 34 }, seven_day_opus: null,
    limits: [{ kind: "weekly_scoped", percent: 57, scope: { model: { display_name: "Fable" } } }],
    extra_usage: { is_enabled: false }, cedar_ember: null };
  const original = { status_code: 200, header: { "Content-Type": ["application/json"] }, body: JSON.stringify(usage) };
  const { quota, calls } = await fixture(t, undefined, undefined, original);
  assert.deepEqual(await (await quota("a")).json(), original);
  assert.equal(calls.length, 1, "a working usage endpoint needs no account discovery or model probe");
});

test("authentication errors are not hidden by available model headers", async (t) => {
  const original = { status_code: 401, header: {}, body: '{"error":"expired credentials"}' };
  const { quota, calls } = await fixture(t, undefined, undefined, original);
  assert.deepEqual(await (await quota("a")).json(), original);
  assert.equal(calls.length, 1);
});

test("scheduler prefers current provider usage over older model observations", async (t) => {
  const { hub } = await fixture(t, undefined, undefined, { status_code: 200, header: {},
    body: JSON.stringify({ five_hour: { utilization: 17 }, seven_day: { utilization: 34 } }) });
  const response = await fetch(hub + "/v0/management/quota-scheduler/status", { headers: { Authorization: `Bearer ${managementKey}` } });
  const account = (await response.json()).accounts["claude-a.json"];
  assert.equal(account.five_hour.used_percent, 17);
  assert.equal(account.seven_day.used_percent, 34);
  assert.equal(account.fetched_at, now.toISOString());
});

test("Claude quota loads from account-isolated model headers while the usage endpoint returns 429", async (t) => {
  const { quota, calls, files } = await fixture(t);
  for (const [index, expected] of [["a", 13], ["b", 7]]) {
    const response = await quota(index);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status_code, 200);
    const usage = JSON.parse(result.body);
    assert.equal(usage.five_hour.utilization, expected);
    assert.equal(usage.seven_day.utilization, 70);
    assert.equal(usage.observed_at, files.find((file) => file.auth_index === index).quota.observed_at);
    assert.equal(usage.five_hour.resets_at, "2026-10-06T18:15:00.000Z");
  }
  assert.equal(calls.filter((call) => call.path.endsWith("api-call")).length, 2);
  assert.ok(calls.filter((call) => call.body).every((call) => JSON.parse(call.body).method === "GET"), "recent headers need no model probes");
});

test("stale, expired, malformed and disabled observations keep the original upstream result", async (t) => {
  const files = [
    observed("disabled", 0.2, { disabled: true }),
    observed("stale", 0.2), observed("expired", 0.2), observed("invalid", 0.2),
    observed("future", 0.2), observed("wrong-provider", 0.2, { type: "codex", provider: "codex" }),
  ];
  files[1].quota.observed_at = "2026-10-05T17:15:00Z";
  files[2].quota.signals["Anthropic-Ratelimit-Unified-5h-Reset"] = String(now.getTime() / 1000 - 1);
  files[3].quota.signals["Anthropic-Ratelimit-Unified-5h-Utilization"] = "NaN";
  files[4].quota.observed_at = "2026-10-07T17:15:00Z";
  const { quota } = await fixture(t, files);
  for (const file of files) {
    assert.equal((await (await quota(file.auth_index)).json()).status_code, 429, file.auth_index);
  }
});

test("quota adaptation authenticates before reading any account data", async (t) => {
  const { apiCall, hub, calls } = await fixture(t);
  const response = await apiCall({ authIndex: "a", method: "GET", url: "https://api.anthropic.com/api/oauth/usage" }, "wrong-key");
  assert.equal(response.status, 401);
  assert.equal((await fetch(hub + "/v0/management/quota-scheduler/status")).status, 401);
  assert.equal(calls.length, 0);
});

test("provider profile, reset mutations, query flags and custom headers bypass the adapter", async (t) => {
  const { apiCall, quota, calls } = await fixture(t);
  await apiCall({ auth_index: "a", method: "GET", url: "https://api.anthropic.com/api/oauth/profile" });
  await apiCall({ auth_index: "a", method: "POST", url: "https://api.anthropic.com/api/organizations/org/reset_rate_limits", data: '{"grant_id":"original"}' });
  await quota("a", { url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1" });
  await quota("a", { header: { Authorization: "Bearer different-token" } });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.path.endsWith("api-call")));
  assert.equal(JSON.parse(calls[1].body).data, '{"grant_id":"original"}');
});

test("legacy dashboard requests accept snake_case credential IDs", async (t) => {
  const { apiCall } = await fixture(t);
  const response = await apiCall({ auth_index: "a", method: "GET", url: "https://api.anthropic.com/api/oauth/usage", header: { Authorization: "Bearer $TOKEN$" } }, managementKey, "/v0/management/api-call");
  assert.equal(JSON.parse((await response.json()).body).five_hour.utilization, 13);
});

test("T3 scheduler status uses observed timestamps, preserves account identity and skips disabled credentials", async (t) => {
  const { hub, files, calls } = await fixture(t, [observed("a", 0.13), observed("b", 0.07, { disabled: true })]);
  const response = await fetch(hub + "/v0/management/quota-scheduler/status", { headers: { Authorization: `Bearer ${managementKey}` } });
  const result = await response.json();
  assert.deepEqual(Object.keys(result.accounts), ["claude-a.json"]);
  const account = result.accounts["claude-a.json"];
  assert.equal(account.five_hour.used_percent, 13);
  assert.equal(account.seven_day.used_percent, 70);
  assert.equal(account.fetched_at, files[0].quota.observed_at);
  assert.equal(calls.length, 2);
});

test("forwarded model requests keep their body, authentication, version headers and status", async (t) => {
  const { hub, calls } = await fixture(t);
  const body = '{"model":"original-model","messages":[]}';
  const response = await fetch(hub + "/v1/messages", { method: "POST", headers: { Authorization: "Bearer original-proxy-key" }, body });
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get("x-cpa-version"), "8.0.15");
  assert.equal(calls[0].authorization, "Bearer original-proxy-key");
});

test("HTTP and WebSocket paths cannot escape the configured upstream", async (t) => {
  let escaped = 0;
  const other = createServer((_request, response) => { escaped++; response.end("escaped"); });
  other.on("upgrade", (_request, socket) => { escaped++; socket.destroy(); });
  const otherUrl = await listen(t, other);
  const { hub } = await fixture(t);
  const path = `/\\${new URL(otherUrl).host}/secret`;
  const options = { hostname: "127.0.0.1", port: new URL(hub).port, path, headers: { Authorization: "Bearer caller-key" } };
  const response = await new Promise((resolve, reject) => {
    const request = httpRequest(options, resolve);
    request.on("error", reject);
    request.end();
  });
  response.resume();
  assert.equal(response.statusCode, 400);
  const request = httpRequest({ ...options, headers: { ...options.headers, Connection: "Upgrade", Upgrade: "websocket" } });
  const rejected = once(request, "error");
  request.end();
  assert.equal((await rejected)[0].code, "ECONNRESET");
  assert.equal(escaped, 0);
});

test("Codex scheduler quota uses the account ID from public management metadata", async (t) => {
  const { hub, calls } = await fixture(t, [{ name: "codex-test.json", auth_index: "codex", type: "codex", id_token: { chatgpt_account_id: "account-test" } }]);
  const response = await fetch(hub + "/v0/management/quota-scheduler/status", { headers: { Authorization: `Bearer ${managementKey}` } });
  const account = (await response.json()).accounts["codex-test.json"];
  assert.equal(account.five_hour.used_percent, 12);
  assert.equal(account.weekly.used_percent, 79);
  assert.equal(account.plan, "pro");
  assert.equal(JSON.parse(calls[1].body).header["Chatgpt-Account-Id"], "account-test");
});

test("idle Claude scheduler accounts remain unknown if the provider quota read fails", async (t) => {
  const { hub } = await fixture(t, [observed("idle", 0.4, { quota: undefined })]);
  const response = await fetch(hub + "/v0/management/quota-scheduler/status", { headers: { Authorization: `Bearer ${managementKey}` } });
  const account = (await response.json()).accounts["claude-idle.json"];
  assert.equal(account.five_hour.known, false);
  assert.equal(account.seven_day.known, false);
  assert.equal(account.fetched_at, undefined);
});

test("a Codex weekly primary window is not mislabeled as five-hour usage", async (t) => {
  const { hub } = await fixture(t, [{ name: "codex-weekly.json", auth_index: "codex", type: "codex", id_token: { chatgpt_account_id: "weekly-only" } }]);
  const response = await fetch(hub + "/v0/management/quota-scheduler/status", { headers: { Authorization: `Bearer ${managementKey}` } });
  const account = (await response.json()).accounts["codex-weekly.json"];
  assert.equal(account.weekly.used_percent, 22);
  assert.equal(account.five_hour, undefined);
});

test("remote model WebSocket upgrades and subsequent bytes reach the original proxy", async (t) => {
  const backend = createServer();
  backend.on("upgrade", (request, socket, head) => {
    assert.equal(request.headers.authorization, "Bearer model-key");
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Proxy-Test: original\r\n\r\n");
    if (head.length) socket.write(head);
    socket.on("data", (data) => socket.write(data));
  });
  const upstreamUrl = await listen(t, backend);
  const hub = await listen(t, createQuotaHub({ upstreamUrl, managementKey }));
  const request = httpRequest(hub + "/v1/responses", { headers: { Connection: "Upgrade", Upgrade: "websocket", Authorization: "Bearer model-key" } });
  request.end();
  const [response, socket] = await once(request, "upgrade");
  t.after(() => socket.destroy());
  assert.equal(response.headers["x-proxy-test"], "original");
  socket.write("model-frame");
  assert.equal((await once(socket, "data"))[0].toString(), "model-frame");
  socket.destroy();
});

test("an idle account with a throttled usage endpoint obtains fresh quota from one concurrent model probe", async (t) => {
  const file = observed("idle", 0.1, { quota: undefined });
  const headers = Object.fromEntries(Object.entries(observed("probe", 0.25).quota.signals).map(([key, value]) => [key, [value]]));
  const { quota, calls } = await fixture(t, [file], { status_code: 200, header: headers, body: '{}' });
  const results = await Promise.all([quota("idle"), quota("idle")]);
  for (const response of results) {
    const result = await response.json();
    assert.equal(result.status_code, 200);
    assert.equal(JSON.parse(result.body).five_hour.utilization, 25);
    assert.equal(JSON.parse(result.body).observed_at, now.toISOString());
  }
  const probes = calls.filter((call) => JSON.parse(call.body || '{}').url === "https://api.anthropic.com/v1/messages");
  assert.equal(probes.length, 1);
  const probe = JSON.parse(probes[0].body);
  assert.equal(probe.authIndex, "idle");
  assert.equal(JSON.parse(probe.data).max_tokens, 1);
  await (await quota("idle")).json();
  assert.equal(calls.filter((call) => JSON.parse(call.body || '{}').url === "https://api.anthropic.com/v1/messages").length, 2, "completed probes are not cached");
});

test("quota-exhausted model responses can still report valid usage headers", async (t) => {
  const file = observed("exhausted", 0.1, { quota: undefined });
  const headers = Object.fromEntries(Object.entries(observed("probe", 1).quota.signals).map(([key, value]) => [key, [value]]));
  const { quota } = await fixture(t, [file], { status_code: 429, header: headers, body: '{"error":"quota exhausted"}' });
  const result = await (await quota("exhausted")).json();
  assert.equal(result.status_code, 200);
  assert.equal(JSON.parse(result.body).five_hour.utilization, 100);
});

const weekly = (index, resetHours, utilization = "0.4", options = {}) => observed(index, 0.1, { quota: { ...observed(index, 0.1).quota, signals: {
  ...observed(index, 0.1).quota.signals,
  "Anthropic-Ratelimit-Unified-7d-Utilization": utilization,
  "Anthropic-Ratelimit-Unified-7d-Reset": String(now.getTime() / 1000 + resetHours * 3600),
} }, ...options });
const priorityPatches = (calls) => calls.filter((call) => call.path === "/v0/management/auth-files/fields").map((call) => JSON.parse(call.body));

test("expiry routing gives the soonest weekly reset the highest built-in priority", async (t) => {
  const { server, calls } = await fixture(t, [weekly("a", 72), weekly("b", 24, "0.4", { priority: 3 }), weekly("c", 120), weekly("d", 12, "1"),
    weekly("off", 1, "0.4", { disabled: true }),
    { name: "codex-only.json", auth_index: "codex", type: "codex", provider: "codex", id_token: { chatgpt_account_id: "account-test" } }]);
  const changes = await server.routeByExpiry();
  // b resets first; d resets sooner but is exhausted. A lone Codex credential has nothing to rank.
  assert.deepEqual(priorityPatches(calls), [
    { name: "claude-b.json", priority: 4 }, { name: "claude-a.json", priority: 3 }, { name: "claude-c.json", priority: 2 }, { name: "claude-d.json", priority: 1 },
  ]);
  assert.deepEqual(changes.map((change) => change.auth_index), ["b", "a", "c", "d"]);
  assert.equal(calls.filter((call) => call.path.endsWith("api-call")).length, 0, "fresh model headers need no provider reads");
});

test("expiry routing leaves priorities alone when they already match", async (t) => {
  const { server, calls } = await fixture(t, [weekly("a", 72, "0.4", { priority: 1 }), weekly("b", 24, "0.4", { priority: 2 })]);
  assert.deepEqual(await server.routeByExpiry(), []);
  assert.deepEqual(priorityPatches(calls), []);
});

test("idle accounts read the usage endpoint once and rank unstarted windows after started ones", async (t) => {
  const usage = { status_code: 200, header: {}, body: JSON.stringify({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 0, resets_at: null } }) };
  const { server, calls } = await fixture(t, [observed("unstarted", 0, { quota: undefined }), weekly("started", 100)], undefined, usage);
  await server.routeByExpiry();
  assert.deepEqual(priorityPatches(calls), [{ name: "claude-started.json", priority: 2 }, { name: "claude-unstarted.json", priority: 1 }]);
  const usageReads = () => calls.filter((call) => call.path.endsWith("api-call") && call.body.includes("/api/oauth/usage")).length;
  assert.equal(usageReads(), 1);
  await server.routeByExpiry();
  assert.equal(usageReads(), 1, "recent windows are reused instead of polling the provider");
});

test("a temporarily unreadable account defers reordering instead of demoting it", async (t) => {
  const { server, calls } = await fixture(t, [observed("throttled", 0, { quota: undefined, priority: 2 }), weekly("known", 24, "0.4", { priority: 1 })]);
  assert.deepEqual(await server.routeByExpiry(), []);
  assert.deepEqual(priorityPatches(calls), []);
});

test("rejected credentials rank after every readable account", async (t) => {
  const rejected = { status_code: 401, header: {}, body: '{"error":"invalid token"}' };
  const { server, calls } = await fixture(t, [observed("revoked", 0, { quota: undefined }), weekly("exhausted", 2, "1"), weekly("known", 24)], undefined, rejected);
  await server.routeByExpiry();
  assert.deepEqual(priorityPatches(calls), [
    { name: "claude-known.json", priority: 3 }, { name: "claude-exhausted.json", priority: 2 }, { name: "claude-revoked.json", priority: 1 },
  ]);
});

test("idle accounts without a known reset are probed once while the usage endpoint is throttled", async (t) => {
  const probe = { status_code: 200, header: {
    "Anthropic-Ratelimit-Unified-5h-Utilization": ["0"], "Anthropic-Ratelimit-Unified-5h-Reset": [String(now.getTime() / 1000 + 3600)],
    "Anthropic-Ratelimit-Unified-7d-Utilization": ["0.1"], "Anthropic-Ratelimit-Unified-7d-Reset": [String(now.getTime() / 1000 + 3600 * 12)],
  }, body: "{}" };
  const { server, calls } = await fixture(t, [observed("idle", 0, { quota: undefined }), weekly("active", 24)], probe);
  await server.routeByExpiry();
  assert.deepEqual(priorityPatches(calls), [{ name: "claude-idle.json", priority: 2 }, { name: "claude-active.json", priority: 1 }]);
  const probes = () => calls.filter((call) => call.body.includes("https://api.anthropic.com/v1/messages")).length;
  assert.equal(probes(), 1);
  await server.routeByExpiry();
  assert.equal(probes(), 1, "a known reset is reused instead of probing again");
});

test("expiry routing changes nothing without any known weekly reset", async (t) => {
  const { server, calls } = await fixture(t, [observed("a", 0, { quota: undefined }), observed("b", 0, { quota: undefined })]);
  assert.deepEqual(await server.routeByExpiry(), []);
  assert.deepEqual(priorityPatches(calls), []);
});

test("concurrent routing passes share one run", async (t) => {
  const { server, calls } = await fixture(t, [weekly("a", 72), weekly("b", 24)]);
  await Promise.all([server.routeByExpiry(), server.routeByExpiry()]);
  assert.equal(priorityPatches(calls).length, 2);
});

test("an enabled hub routes on start and logs only credential indexes", async (t) => {
  const files = [weekly("a", 72), weekly("b", 24)];
  const backend = createServer(async (request, response) => {
    for await (const _ of request);
    response.end(request.url === "/v0/management/auth-files" ? JSON.stringify({ files }) : "{}");
  });
  const upstreamUrl = await listen(t, backend);
  const lines = [];
  let logged;
  const done = new Promise((resolve) => { logged = resolve; });
  await listen(t, createQuotaHub({ upstreamUrl, managementKey, now: () => now, expiryRouting: true,
    log: (line) => { lines.push(line); if (lines.length === 2) logged(); } }));
  await done;
  assert.deepEqual(lines, ["expiry routing: claude credential b -> priority 2", "expiry routing: claude credential a -> priority 1"]);
});

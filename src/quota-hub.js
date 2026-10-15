import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";

const STATUS_PATH = "/v0/management/quota-scheduler/status";
const API_CALL_PATHS = new Set(["/v0/management/api-call", "/v8/management/requests/api-call"]);
const MAX_OBSERVATION_AGE_MS = 15 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const ROUTED_PROVIDERS = ["claude", "codex"];
const MAX_CACHED_WINDOW_AGE_MS = 30 * 60_000;
const REJECTED_STATUSES = new Set([401, 403]);
const NOT_STARTED = Object.freeze({ used_percent: 0, known: true, hard_limited: false });

export function createQuotaHub({ upstreamUrl, managementKey, claudeUserAgent = "claude-cli/2.1.300 (external, cli)", fetchImpl = fetch, now = () => new Date(),
  expiryRouting = false, routingIntervalMs = 5 * 60_000, log = () => {} }) {
  const upstreamBase = new URL(upstreamUrl);
  if (upstreamBase.protocol !== "http:" || upstreamBase.hostname !== "127.0.0.1" ||
      upstreamBase.username || upstreamBase.password || !managementKey) {
    throw new Error("quota hub requires a loopback proxy and management key");
  }
  const managementFetch = (path, init = {}) => fetchImpl(new URL(path, upstreamBase), {
    ...init, headers: { Authorization: `Bearer ${managementKey}`, ...init.headers },
    signal: AbortSignal.timeout(8_000),
  });
  const readFiles = async () => {
    const response = await managementFetch("/v0/management/auth-files");
    if (!response.ok) throw new Error("could not read proxy quota signals");
    const payload = await response.json();
    if (!Array.isArray(payload.files)) throw new Error("invalid proxy account response");
    return payload.files;
  };
  const providerUsage = (file, url, headers) => managementFetch("/v8/management/requests/api-call", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authIndex: file.auth_index, method: "GET", url, header: { Authorization: "Bearer $TOKEN$", ...headers } }),
  }).then((response) => response.json());
  const probes = new Map();
  const probeUsage = async (file) => {
    if (!file || file.disabled || file.type !== "claude" || file.provider !== "claude") return undefined;
    if (probes.has(file.auth_index)) return probes.get(file.auth_index);
    // Share only a pending request. Completed probe data is never cached in the hub.
    const pending = (async () => {
      const result = await managementFetch("/v8/management/requests/api-call", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authIndex: file.auth_index, method: "POST", url: "https://api.anthropic.com/v1/messages",
          header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20", "User-Agent": claudeUserAgent },
          data: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "." }] }) }),
      }).then((response) => response.json());
      if (![200, 429].includes(result.status_code)) return undefined;
      const signals = Object.fromEntries(Object.entries(result.header ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
      return observedClaudeUsage({ ...file, quota: { observed_at: now().toISOString(), signals } }, now());
    })().catch(() => undefined);
    probes.set(file.auth_index, pending);
    try { return await pending; } finally { probes.delete(file.auth_index); }
  };
  const claudeUsage = (file) => providerUsage(file, "https://api.anthropic.com/api/oauth/usage", {
    "anthropic-beta": "oauth-2025-04-20", "User-Agent": claudeUserAgent,
  });
  // Codex keeps its existing provider query; OAuth credentials stay inside the proxy.
  // Returns null when the account cannot be read at all and undefined when the read may succeed later.
  const codexAccount = async (file) => {
    try {
      const accountId = file.id_token?.chatgpt_account_id ?? file.account_id;
      if (typeof accountId !== "string" || !accountId) return null;
      const result = await providerUsage(file, "https://chatgpt.com/backend-api/wham/usage", {
        "Chatgpt-Account-Id": accountId, "User-Agent": "codex_cli_rs/0.76.0",
      });
      if (REJECTED_STATUSES.has(result.status_code)) return null;
      if (result.status_code !== 200) return undefined;
      return schedulerAccount("codex", JSON.parse(result.body), now().toISOString());
    } catch { return undefined; }
  };

  // Weekly reset times only move when a window resets, so routing reuses recent reads
  // instead of polling a provider usage endpoint that also serves the dashboard and T3.
  // Returns the weekly window (without reset_at when not started), null when the credential is
  // rejected, or undefined when the read failed and may succeed on a later pass.
  const weeklyWindows = new Map();
  const weeklyWindow = async (file) => {
    const cached = weeklyWindows.get(file.name);
    const usable = cached && (!cached.window.reset_at || Date.parse(cached.window.reset_at) > now().getTime());
    const observed = file.type === "claude" ? schedulerAccount("claude", observedClaudeUsage(file, now()) ?? {}, "").seven_day : undefined;
    if (!observed && usable && now().getTime() - cached.at < MAX_CACHED_WINDOW_AGE_MS) return cached.window;
    let window = observed;
    if (!window && file.type === "claude") {
      try {
        const result = await claudeUsage(file);
        if (REJECTED_STATUSES.has(result.status_code)) window = null;
        else if (result.status_code === 200) window = schedulerAccount("claude", JSON.parse(result.body), "").seven_day ?? NOT_STARTED;
      } catch { /* Fall back to the last known window below. */ }
      // Expiry routing leaves lower-priority accounts idle, so they have no model headers to observe.
      if (window === undefined && !usable) {
        const probed = await probeUsage(file);
        if (probed) window = schedulerAccount("claude", probed, "").seven_day;
      }
    } else if (!window) {
      const account = await codexAccount(file);
      window = account && (account.weekly ?? NOT_STARTED);
    }
    if (window) weeklyWindows.set(file.name, { window, at: now().getTime() });
    return window === undefined && usable ? cached.window : window;
  };
  // Built-in priority routing sends new work to the highest priority, failing over on cooldowns.
  let routing;
  const routeByExpiry = () => routing ??= (async () => {
    const files = (await readFiles()).filter((file) => !file.disabled && ROUTED_PROVIDERS.includes(file.type) && file.provider === file.type);
    const changes = [];
    for (const provider of ROUTED_PROVIDERS) {
      const group = files.filter((file) => file.type === provider);
      if (group.length < 2) continue;
      const entries = await Promise.all(group.map(async (file) => ({ file, window: await weeklyWindow(file) })));
      // Reordering around a temporarily unreadable account would demote it for no reason.
      if (entries.some(({ window }) => window === undefined)) {
        log(`expiry routing deferred: ${provider} quota is temporarily unavailable`);
        continue;
      }
      const ranked = expiryOrder(entries, now());
      if (!ranked) continue;
      for (const [index, file] of ranked.entries()) {
        const priority = ranked.length - index;
        if (Number(file.priority ?? 0) === priority) continue;
        const response = await managementFetch("/v0/management/auth-files/fields", {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: file.name, priority }),
        });
        if (!response.ok) throw new Error(`could not update routing priority for credential ${file.auth_index}`);
        changes.push({ provider, auth_index: file.auth_index, priority });
      }
    }
    return changes;
  })().finally(() => { routing = undefined; });

  const server = createServer(async (request, response) => {
    try {
      if (!request.url.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\")) return json(response, 400, { error: "invalid_path" });
      const path = new URL(request.url, upstreamBase).pathname;
      if (path === "/healthz") return json(response, 200, { status: "ok" });
      if (/^\/v(?:0|8)\/management(?:\/|$)/.test(path) && !authenticated(request.headers, managementKey)) {
        return json(response, 401, { error: "unauthorized" });
      }
      if (request.method === "GET" && path === STATUS_PATH) {
        const files = await readFiles();
        const entries = await Promise.all(files.filter((file) => !file.disabled && ["claude", "codex"].includes(file.type))
          .map(async (file) => {
            if (file.type === "claude") {
              try {
                const result = await claudeUsage(file);
                if (result.status_code === 200) return [file.name, schedulerAccount("claude", JSON.parse(result.body), now().toISOString())];
                if (result.status_code === 429) {
                  const usage = observedClaudeUsage(file, now()) ?? await probeUsage(file);
                  if (usage) return [file.name, schedulerAccount("claude", usage, usage.observed_at)];
                }
              } catch { /* An idle account can have neither observations nor a working usage endpoint. */ }
              return [file.name, unknownAccount("claude")];
            }
            return [file.name, await codexAccount(file) ?? unknownAccount("codex")];
          }));
        return json(response, 200, { accounts: Object.fromEntries(entries) });
      }
      if (request.method === "POST" && API_CALL_PATHS.has(path)) {
        const body = await readBody(request);
        let payload;
        try { payload = JSON.parse(body); } catch { return forward(request, response, upstreamBase, body); }
        if (isClaudeUsageRead(payload)) {
          // Full usage includes scoped model limits and extras absent from model headers.
          const original = await managementFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body });
          const result = await original.json();
          if (result.status_code !== 429) return json(response, original.status, result);
          let usage, file;
          try {
            const index = (payload.auth_index ?? payload.authIndex ?? payload.AuthIndex)?.trim();
            file = (await readFiles()).find((file) => file.auth_index === index);
            usage = observedClaudeUsage(file, now());
          } catch { /* Account discovery failure must not hide the original provider response. */ }
          if (usage) return json(response, 200, quotaResponse(usage, "model-response"));
          usage = await probeUsage(file);
          if (usage) return json(response, 200, quotaResponse(usage, "model-probe"));
          return json(response, original.status, result);
        }
        return forward(request, response, upstreamBase, body);
      }
      forward(request, response, upstreamBase);
    } catch (error) {
      if (!response.headersSent) json(response, error.code === "BODY_TOO_LARGE" ? 413 : 502, { error: "quota_hub_request_failed" });
      else response.destroy();
    }
  });
  // The existing remote proxy URL may also carry Codex WebSocket traffic.
  server.on("upgrade", (request, socket, head) => {
    if (!request.url.startsWith("/") || request.url.startsWith("//") || request.url.includes("\\")) return socket.destroy();
    const upstream = httpRequest(new URL(request.url, upstreamBase), { method: request.method, headers: request.headers });
    upstream.on("upgrade", (incoming, upstreamSocket, upstreamHead) => {
      socket.write(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\n${incoming.rawHeaders.reduce((text, value, index, headers) => index % 2 ? text : `${text}${value}: ${headers[index + 1]}\r\n`, "")}\r\n`);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => socket.destroy());
      socket.on("end", () => upstreamSocket.destroy());
      upstreamSocket.on("end", () => socket.destroy());
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstream.on("response", (incoming) => { incoming.resume(); socket.end(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\nConnection: close\r\n\r\n`); });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  server.routeByExpiry = routeByExpiry;
  if (expiryRouting) {
    let timer;
    const tick = () => routeByExpiry().then((changes) => {
      for (const change of changes) log(`expiry routing: ${change.provider} credential ${change.auth_index} -> priority ${change.priority}`);
    }, (error) => log(`expiry routing skipped: ${error.message}`));
    server.on("listening", () => { tick(); timer = setInterval(tick, routingIntervalMs); timer.unref(); });
    server.on("close", () => clearInterval(timer));
  }
  return server;
}

// Soonest weekly reset first: that quota is lost soonest if unused. Then come windows that have
// not started, exhausted windows and finally rejected credentials (null). Without any known
// reset there is nothing to rank, so existing priorities stay unchanged.
export function expiryOrder(entries, now) {
  if (!entries.some(({ window }) => window?.reset_at)) return undefined;
  const rank = ({ window }) => {
    const reset = Date.parse(window?.reset_at);
    if (window === null) return [3, 0];
    if (window.hard_limited) return [2, Number.isFinite(reset) ? reset : Infinity];
    if (Number.isFinite(reset) && reset > now.getTime()) return [0, reset];
    return [1, 0];
  };
  return entries.map((entry) => ({ ...entry, rank: rank(entry) }))
    .sort((left, right) => left.rank[0] - right.rank[0] || left.rank[1] - right.rank[1] || left.file.name.localeCompare(right.file.name))
    .map(({ file }) => file);
}

function isClaudeUsageRead(payload) {
  if (typeof payload?.method !== "string" || payload.method.toUpperCase() !== "GET" || payload.url !== "https://api.anthropic.com/api/oauth/usage" || payload.proxy_url || payload.data) return false;
  const headers = Object.fromEntries(Object.entries(payload.header ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  return headers.authorization === "Bearer $TOKEN$" && Object.keys(headers).every((key) =>
    ["authorization", "anthropic-beta", "user-agent", "content-type", "accept"].includes(key));
}

function quotaResponse(usage, source) {
  return { status_code: 200,
    header: { "Content-Type": ["application/json"], "X-Claudex-Quota-Source": [source], "X-Claudex-Quota-Observed-At": [usage.observed_at] },
    body: JSON.stringify(usage) };
}

function observedClaudeUsage(file, now) {
  if (!file || file.disabled || file.type !== "claude" || file.provider !== "claude") return undefined;
  const observedAt = Date.parse(file.quota?.observed_at);
  const age = now.getTime() - observedAt;
  if (!Number.isFinite(age) || age < 0 || age > MAX_OBSERVATION_AGE_MS) return undefined;
  const signals = Object.fromEntries(Object.entries(file.quota?.signals ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const window = (slug) => {
    const utilization = numeric(signals[`anthropic-ratelimit-unified-${slug}-utilization`]);
    const reset = numeric(signals[`anthropic-ratelimit-unified-${slug}-reset`]);
    if (utilization === undefined || utilization < 0 || utilization > 1 || reset === undefined ||
        !Number.isSafeInteger(reset) || reset * 1000 <= now.getTime() || reset > 8_640_000_000_000) return undefined;
    return { utilization: Math.round(utilization * 10_000) / 100, resets_at: new Date(reset * 1000).toISOString() };
  };
  const five_hour = window("5h");
  const seven_day = window("7d");
  if (!five_hour || !seven_day) return undefined;
  const usage = { five_hour, seven_day, observed_at: new Date(observedAt).toISOString() };
  for (const [slug, key] of [["7d_opus", "seven_day_opus"], ["7d_sonnet", "seven_day_sonnet"], ["7d_oi", "seven_day_overage_included"]]) {
    const value = window(slug);
    if (value) usage[key] = value;
  }
  return usage;
}

function schedulerAccount(provider, payload, fetchedAt) {
  const window = (value) => {
    const used = numeric(value?.utilization ?? value?.used_percent);
    if (used === undefined) return undefined;
    const reset = value.resets_at ?? (numeric(value.reset_at) ? new Date(Number(value.reset_at) * 1000).toISOString() : undefined);
    return { used_percent: Math.max(0, Math.min(100, used)), known: true, hard_limited: used >= 100, ...(reset ? { reset_at: reset } : {}) };
  };
  if (provider === "claude") return { provider, fetched_at: fetchedAt, five_hour: window(payload.five_hour), seven_day: window(payload.seven_day) };
  const account = { provider, plan: payload.plan_type, fetched_at: fetchedAt };
  for (const [value, fallback] of [[payload.rate_limit?.primary_window, "five_hour"], [payload.rate_limit?.secondary_window, "weekly"]]) {
    const quota = window(value);
    if (quota) account[numeric(value.limit_window_seconds) >= 604800 ? "weekly" : numeric(value.limit_window_seconds) ? "five_hour" : fallback] = quota;
  }
  return account;
}

function unknownAccount(provider) {
  const unknown = { used_percent: 0, known: false, hard_limited: false };
  return { provider, five_hour: unknown, [provider === "claude" ? "seven_day" : "weekly"]: unknown };
}

function numeric(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function authenticated(headers, expected) {
  const supplied = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? headers["x-management-key"];
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(supplied), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(payload));
}

function forward(request, response, upstreamBase, body) {
  const upstream = httpRequest(new URL(request.url, upstreamBase), { method: request.method, headers: request.headers }, (incoming) => {
    response.writeHead(incoming.statusCode, incoming.headers);
    incoming.on("error", () => response.destroy());
    incoming.pipe(response);
  });
  upstream.on("error", () => { if (!response.headersSent) json(response, 502, { error: "proxy_unavailable" }); else response.destroy(); });
  response.on("close", () => upstream.destroy());
  if (body) upstream.end(body);
  else request.pipe(upstream);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configIndex = process.argv.indexOf("--config");
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (config.host !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
        new URL(config.upstreamUrl).port === String(config.port)) throw new Error("invalid quota hub configuration");
    const server = createQuotaHub({ ...config, expiryRouting: config.expiryRouting !== false, log: (line) => console.log(line) });
    server.listen(config.port, config.host);
    server.on("error", () => { console.error("quota hub could not listen"); process.exitCode = 1; });
    const stop = () => { server.close(() => process.exit(0)); server.closeIdleConnections(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch { console.error("quota hub requires --config PATH with valid loopback configuration"); process.exitCode = 1; }
}

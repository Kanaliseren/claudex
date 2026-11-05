import { readFile, stat } from "node:fs/promises";
import { atomicWrite, exists, randomSecret } from "./util.js";

export async function writeProxyConfig(paths, manifest, { port = 8317, ...overrides } = {}) {
  let proxyKey = randomSecret();
  if (await exists(paths.proxyConfig)) {
    proxyKey = await readProxyKey(paths.proxyConfig);
  }
  const options = { ...(await readProxyOptions(paths.proxyConfig)), ...overrides };
  const clickhousePassword = options.clickhouse ? await readClickhousePassword(paths.clickhousePassword) : "";
  const yaml = renderProxyConfig({ paths, manifest, port, proxyKey, ...options, clickhousePassword });
  await atomicWrite(paths.proxyConfig, yaml, 0o600);
  return { proxyKey, port };
}

export const clickhouseWriter = "claudex_writer";

// The password lives in its own owner-only file so it is never passed on a
// command line; it is copied into the owner-only proxy config on each render.
async function readClickhousePassword(path) {
  if (!(await exists(path))) throw new Error(`ClickHouse logging needs a password file: ${path}`);
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o077) !== 0) {
    throw new Error(`ClickHouse password file must be owner-only (chmod 600): ${path}`);
  }
  const password = (await readFile(path, "utf8")).trim();
  if (!password) throw new Error(`ClickHouse password file is empty: ${path}`);
  return password;
}

export function renderProxyConfig({ paths, manifest, port, proxyKey, dashboard = false, managementKey = "", sessionAffinity = false, strategy = "round-robin", clickhouse = null, clickhousePassword = "" }) {
  if (dashboard && !managementKey) throw new Error("dashboard requires a management key");
  if (!["round-robin", "fill-first"].includes(strategy)) throw new Error("unsupported routing strategy");
  if (clickhouse && !clickhousePassword) throw new Error("ClickHouse logging requires a password");
  const claudeCodeVersion = manifest.compatibility.claudeCode.tested.at(-1);
  return `# Managed by Claudex. Edit through the package, not in place.
host: "127.0.0.1"
port: ${Number(port)}

tls:
  enable: false
  cert: ""
  key: ""

remote-management:
  allow-remote: false
  secret-key: ${yamlString(dashboard ? managementKey : "")}
  disable-control-panel: ${!dashboard}

auth-dir: ${yamlString(paths.authDir)}

api-keys:
  - ${yamlString(proxyKey)}

debug: false
logging-to-file: false
request-log: false
transient-error-cooldown-seconds: -1

routing:
  strategy: ${yamlString(strategy)}
  session-affinity: ${Boolean(sessionAffinity)}
  session-affinity-ttl: "1h"

claude-header-defaults:
  user-agent: ${yamlString(`claude-cli/${claudeCodeVersion} (external, cli)`)}
${clickhouse ? renderClickhouseSink(paths, clickhouse, clickhousePassword) : ""}`;
}

// clickhouse-sink observes traffic without changing it. Every secret in the
// config and auth directories (proxy key, dashboard key, ClickHouse password,
// OAuth tokens) is redacted before a row is stored.
function renderClickhouseSink(paths, { url, database }, password) {
  return `
plugins:
  enabled: true
  dir: ${yamlString(paths.pluginsDir)}
  configs:
    clickhouse-sink:
      enabled: true
      url: ${yamlString(url)}
      database: ${yamlString(database)}
      username: ${yamlString(clickhouseWriter)}
      password: ${yamlString(password)}
      redact-files:
        - ${yamlString(paths.configDir)}
        - ${yamlString(paths.authDir)}
`;
}

export function parseClickhouseOptions(url, database = "cliproxy") {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid ClickHouse URL: ${url}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("ClickHouse URL must be http(s) without credentials");
  }
  if (!/^\w+$/.test(database)) throw new Error("ClickHouse database must contain only letters, digits and underscores");
  return { url: parsed.href.replace(/\/$/, ""), database };
}

export async function readProxyKey(path) {
  const text = await readFile(path, "utf8");
  const block = text.match(/^api-keys:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] ?? "";
  const value = block.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m);
  const key = value?.[1] ?? value?.[2] ?? value?.[3];
  if (!key) throw new Error(`no inbound API key found in ${path}`);
  return key;
}

export async function readProxySummary(path) {
  const text = await readFile(path, "utf8");
  return {
    host: parseYamlScalar(scalar(text, "host")),
    port: Number(scalar(text, "port")),
    authDir: parseYamlScalar(scalar(text, "auth-dir")),
    remoteManagementDisabled: /allow-remote:\s*false/.test(text),
    tlsDisabled: /tls:\s*\n(?:\s+.*\n)*?\s+enable:\s*false/m.test(text),
  };
}

export async function readQuotaHubConfig(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (config?.host !== "127.0.0.1" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
      typeof config.authDir !== "string" || !config.authDir || typeof config.managementKey !== "string" || !config.managementKey) {
    throw new Error("invalid existing quota hub configuration");
  }
  return config;
}

function parseYamlScalar(value) {
  if (value === undefined) return undefined;
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function scalar(text, name) {
  return text.match(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m"))?.[1];
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

// Preserve supported local choices, including the hash written by CLIProxyAPI at startup.
export async function readProxyOptions(path) {
  if (!(await exists(path))) return {};
  const text = await readFile(path, "utf8");
  const blockValue = (block, name) => {
    const contents = text.match(new RegExp(`^${block}:\\s*\\n((?:^[ \t]+.*\\n?)*)`, "m"))?.[1] ?? "";
    return parseYamlScalar(contents.match(new RegExp(`^[ \t]+${name}:\\s*(.+?)\\s*$`, "m"))?.[1]);
  };
  const clickhouseURL = blockValue("plugins", "url");
  return {
    dashboard: blockValue("remote-management", "disable-control-panel") === "false",
    managementKey: blockValue("remote-management", "secret-key") ?? "",
    sessionAffinity: blockValue("routing", "session-affinity") === "true",
    strategy: blockValue("routing", "strategy") ?? "round-robin",
    clickhouse: clickhouseURL ? { url: clickhouseURL, database: blockValue("plugins", "database") ?? "cliproxy" } : null,
  };
}

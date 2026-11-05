import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { platformKey } from "./paths.js";
import { atomicWrite, ensureDir, exists, randomSecret, sha256File } from "./util.js";

export async function writeProxyConfig(paths, manifest, { port = 8317, ...overrides } = {}) {
  let proxyKey = randomSecret();
  if (await exists(paths.proxyConfig)) {
    proxyKey = await readProxyKey(paths.proxyConfig);
  }
  const options = { ...(await readProxyOptions(paths.proxyConfig)), ...overrides };
  if (options.requestLog) await verifyTap(paths, manifest);
  const yaml = renderProxyConfig({ paths, manifest, port, proxyKey, ...options });
  await atomicWrite(paths.proxyConfig, yaml, 0o600);
  return { proxyKey, port };
}

// The proxy loads every library under its plugin directory in-process, next
// to the OAuth tokens, so only the reviewed tap build pinned in the channel
// may be there.
export async function verifyTap(paths, manifest) {
  const expected = manifest.plugins?.["claudex-tap"]?.assets?.[platformKey()]?.sha256;
  if (!expected) throw new Error(`no reviewed claudex-tap build is pinned for ${platformKey()}`);
  const libraries = (await exists(paths.pluginsDir))
    ? (await readdir(paths.pluginsDir, { recursive: true })).filter((name) => /\.(so|dylib|dll)$/i.test(name))
    : [];
  if (libraries.length !== 1 || libraries[0] !== "claudex-tap.so") {
    throw new Error(`${paths.pluginsDir} must hold only claudex-tap.so (build it with deploy/clickhouse/build-plugin.sh); found: ${libraries.join(", ") || "nothing"}`);
  }
  const actual = await sha256File(join(paths.pluginsDir, "claudex-tap.so"));
  if (actual !== expected) throw new Error(`claudex-tap checksum mismatch: expected ${expected}, got ${actual}`);
  await ensureDir(dirname(paths.tapSocket));
}

export function renderProxyConfig({ paths, manifest, port, proxyKey, dashboard = false, managementKey = "", sessionAffinity = false, strategy = "round-robin", requestLog = false }) {
  if (dashboard && !managementKey) throw new Error("dashboard requires a management key");
  if (!["round-robin", "fill-first"].includes(strategy)) throw new Error("unsupported routing strategy");
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
${requestLog ? renderRequestLog(paths) : ""}`;
}

// claudex-tap only copies traffic to the collector's socket and never changes
// it; redaction and storage happen outside the proxy (deploy/clickhouse).
function renderRequestLog(paths) {
  return `
plugins:
  enabled: true
  dir: ${yamlString(paths.pluginsDir)}
  configs:
    claudex-tap:
      enabled: true
      socket: ${yamlString(paths.tapSocket)}
`;
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
  return {
    dashboard: blockValue("remote-management", "disable-control-panel") === "false",
    managementKey: blockValue("remote-management", "secret-key") ?? "",
    sessionAffinity: blockValue("routing", "session-affinity") === "true",
    strategy: blockValue("routing", "strategy") ?? "round-robin",
    requestLog: blockValue("plugins", "socket") !== undefined,
  };
}

import { readFile } from "node:fs/promises";
import { atomicWrite, exists, randomSecret } from "./util.js";

export async function writeProxyConfig(paths, manifest, { port = 8317 } = {}) {
  let proxyKey = randomSecret();
  if (await exists(paths.proxyConfig)) {
    proxyKey = await readProxyKey(paths.proxyConfig);
  }
  const yaml = renderProxyConfig({ paths, manifest, port, proxyKey });
  await atomicWrite(paths.proxyConfig, yaml, 0o600);
  return { proxyKey, port };
}

export function renderProxyConfig({ paths, manifest, port, proxyKey }) {
  const astra = manifest.models.astra;
  const sol = manifest.models.sol;
  const claudeCodeVersion = manifest.compatibility.claudeCode.tested.at(-1);
  const models = [astra, sol];
  const aliases = models.flatMap(modelAliases);
  return `# Managed by Claudex. Edit through the package, not in place.
host: "127.0.0.1"
port: ${Number(port)}

tls:
  enable: false
  cert: ""
  key: ""

remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true

auth-dir: ${yamlString(paths.authDir)}

api-keys:
  - ${yamlString(proxyKey)}

debug: false
logging-to-file: false
request-log: false
transient-error-cooldown-seconds: -1

claude-header-defaults:
  user-agent: ${yamlString(`claude-cli/${claudeCodeVersion} (external, cli)`)}

oauth-excluded-models:
  claude:
${aliases.map((alias) => `    - ${yamlString(alias)}`).join("\n")}

oauth-model-alias:
  codex:
${models.flatMap((model) => modelAliases(model).map((alias) => `    - name: ${yamlString(model.upstream)}
      alias: ${yamlString(alias)}
      fork: true
      display-name: ${yamlString(model.displayName)}`)).join("\n")}
`;
}

function modelAliases(model) {
  return [...new Set([model.alias, ...(model.aliases ?? [])])];
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
    remoteManagementDisabled: /disable-control-panel:\s*true/.test(text) && /allow-remote:\s*false/.test(text),
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

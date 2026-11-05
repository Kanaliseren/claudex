import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readProxyKey, readProxyOptions, readProxySummary, writeProxyConfig } from "./config.js";
import { restartService } from "./service.js";
import { atomicWrite, exists, sha256File, sleep, withFileLock } from "./util.js";
import { platformKey } from "./paths.js";
import { assertOwnedProxy } from "./shared.js";
import { managementEndpoint } from "./hub.js";

export async function configure(paths, manifest, options = {}) {
  await assertOwnedProxy(paths);
  return withFileLock(paths.lockFile, async () => {
    const previous = await readFile(paths.proxyConfig, "utf8");
    const { port } = await readProxySummary(paths.proxyConfig);
    const settings = await readProxyOptions(paths.proxyConfig);
    for (const name of ["dashboard", "sessionAffinity", "strategy", "clickhouse"]) {
      if (options[name] !== undefined) settings[name] = options[name];
    }
    if (settings.clickhouse) await verifyClickhouseSink(paths, manifest);
    if (settings.dashboard && !settings.managementKey) {
      const key = (await exists(paths.dashboardKey))
        ? (await readFile(paths.dashboardKey, "utf8")).trim()
        : `dashboard_${randomBytes(32).toString("base64url")}`;
      if (!key || Buffer.byteLength(key) > 72) throw new Error("dashboard key must contain 1–72 bytes for upstream bcrypt");
      await atomicWrite(paths.dashboardKey, `${key}\n`, 0o600);
      settings.managementKey = key;
    }
    try {
      await writeProxyConfig(paths, manifest, { port, ...settings });
      const restarted = await restartService(paths, options);
      if (restarted) await waitForProxy(paths, port, options.fetchImpl ?? fetch);
      return { ...(await dashboardSummary(paths)), restarted };
    } catch (error) {
      await atomicWrite(paths.proxyConfig, previous, 0o600);
      await restartService(paths, options).catch(() => {});
      throw error;
    }
  });
}

// The proxy loads every library in the plugin directory in-process, next to
// the OAuth tokens, so only the reviewed build pinned in the channel may run.
async function verifyClickhouseSink(paths, manifest) {
  const pin = manifest.plugins?.["clickhouse-sink"];
  const expected = pin?.assets?.[platformKey()]?.sha256;
  if (!expected) throw new Error(`no reviewed clickhouse-sink build is pinned for ${platformKey()}`);
  const library = join(paths.pluginsDir, "clickhouse-sink.so");
  if (!(await exists(library))) throw new Error(`clickhouse-sink is not installed: ${library} (run deploy/clickhouse/build-plugin.sh)`);
  const libraries = (await readdir(paths.pluginsDir)).filter((name) => /\.(so|dylib|dll)$/i.test(name));
  if (libraries.length !== 1) throw new Error(`unexpected plugin libraries in ${paths.pluginsDir}: ${libraries.join(", ")}`);
  const actual = await sha256File(library);
  if (actual !== expected) throw new Error(`clickhouse-sink checksum mismatch: expected ${expected}, got ${actual}`);
}

async function waitForProxy(paths, port, fetchImpl) {
  const key = await readProxyKey(paths.proxyConfig);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("proxy did not become ready after configuration change; restored previous configuration");
}

export async function dashboardSummary(paths) {
  const options = await readProxyOptions(paths.proxyConfig);
  const endpoint = await managementEndpoint(paths);
  return {
    enabled: options.dashboard,
    url: `${endpoint.url}/management.html`,
    keyFile: paths.dashboardKey,
    strategy: options.strategy,
    sessionAffinity: options.sessionAffinity,
    clickhouse: options.clickhouse,
  };
}

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { readProxyKey, readProxyOptions, readProxySummary, writeProxyConfig } from "./config.js";
import { restartService } from "./service.js";
import { atomicWrite, exists, sleep, withFileLock } from "./util.js";
import { assertOwnedProxy } from "./shared.js";

export async function configure(paths, manifest, options = {}) {
  await assertOwnedProxy(paths);
  return withFileLock(paths.lockFile, async () => {
    const previous = await readFile(paths.proxyConfig, "utf8");
    const { port } = await readProxySummary(paths.proxyConfig);
    const settings = await readProxyOptions(paths.proxyConfig);
    for (const name of ["dashboard", "sessionAffinity", "strategy"]) {
      if (options[name] !== undefined) settings[name] = options[name];
    }
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
  const { host, port } = await readProxySummary(paths.proxyConfig);
  return {
    enabled: options.dashboard,
    url: `http://${host}:${port}/management.html`,
    keyFile: paths.dashboardKey,
    strategy: options.strategy,
    sessionAffinity: options.sessionAffinity,
  };
}

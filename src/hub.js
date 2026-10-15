import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readProxyOptions, readProxySummary, readQuotaHubConfig } from "./config.js";
import { assertOwnedProxy } from "./shared.js";
import { atomicWrite, exists, run, sleep, withFileLock } from "./util.js";

// Only explicitly installed adapters replace the official management endpoint.
export async function managementEndpoint(paths) {
  const proxy = await readProxySummary(paths.proxyConfig);
  const upstreamUrl = `http://${proxy.host}:${proxy.port}`;
  if (await exists(paths.hubConfig)) {
    const hub = await readQuotaHubConfig(paths.hubConfig);
    if (hub.upstreamUrl === upstreamUrl) return { url: `http://${hub.host}:${hub.port}`, keyFile: paths.dashboardKey };
  }
  return { url: upstreamUrl, keyFile: paths.dashboardKey };
}

export async function installQuotaHub(paths, manifest, { platform = process.platform, port, runCommand = run, fetchImpl = fetch } = {}) {
  await assertOwnedProxy(paths);
  if (platform !== "linux") throw new Error("quota hub installation currently requires a Linux user service");
  return withFileLock(paths.lockFile, async () => {
    if (!(await readProxyOptions(paths.proxyConfig)).dashboard) throw new Error("enable the dashboard before installing the quota adapter");
    const proxy = await readProxySummary(paths.proxyConfig);
    const managementKey = (await readFile(paths.dashboardKey, "utf8")).trim();
    const existing = await exists(paths.hubConfig) ? await readQuotaHubConfig(paths.hubConfig) : {};
    const hubPort = port ?? existing.port ?? (proxy.port + 1);
    if (proxy.host !== "127.0.0.1" || !Number.isInteger(hubPort) || hubPort < 1 || hubPort > 65535 || hubPort === proxy.port || !managementKey) {
      throw new Error("quota adapter requires separate loopback ports and a management key");
    }
    const scriptPath = join(paths.dataDir, "hub", "quota-hub.mjs");
    const config = { ...existing, host: "127.0.0.1", port: hubPort, authDir: proxy.authDir, managementKey,
      upstreamUrl: `http://${proxy.host}:${proxy.port}`,
      claudeUserAgent: `claude-cli/${manifest.compatibility.claudeCode.tested.at(-1)} (external, cli)` };
    const quote = (value) => `"${String(value).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const unit = `[Unit]
Description=Claudex quota adapter
After=network-online.target ${paths.serviceName}
Requires=${paths.serviceName}

[Service]
Type=simple
ExecStart=${quote(process.execPath)} ${quote(scriptPath)} --config ${quote(paths.hubConfig)}
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
    const files = [[paths.hubConfig, `${JSON.stringify(config, null, 2)}\n`],
      [scriptPath, await readFile(new URL("./quota-hub.js", import.meta.url), "utf8")], [paths.hubSystemdUnit, unit]];
    const previous = await Promise.all(files.map(async ([path]) => ({ path, content: await exists(path) ? await readFile(path) : undefined })));
    const backup = join(paths.backupsDir, `quota-hub-${Date.now()}`);
    for (const [index, file] of previous.entries()) {
      if (file.content !== undefined) await atomicWrite(join(backup, `${index}.bak`), file.content, 0o600);
    }
    try {
      for (const [path, content] of files) await atomicWrite(path, content, 0o600);
      await runCommand("systemctl", ["--user", "daemon-reload"]);
      await runCommand("systemctl", ["--user", "enable", paths.hubServiceName]);
      await runCommand("systemctl", ["--user", "restart", paths.hubServiceName]);
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const response = await fetchImpl(`http://127.0.0.1:${hubPort}/v0/management/auth-files`, {
            headers: { Authorization: `Bearer ${managementKey}` }, signal: AbortSignal.timeout(1_000),
          });
          if (response.ok && Array.isArray((await response.json()).files)) { ready = true; break; }
        } catch {}
        await sleep(100);
      }
      if (!ready) throw new Error("quota adapter did not become ready; restored previous hub");
    } catch (error) {
      for (const file of previous) {
        if (file.content !== undefined) await atomicWrite(file.path, file.content, 0o600);
        else await rm(file.path, { force: true });
      }
      await runCommand("systemctl", ["--user", "daemon-reload"]).catch(() => {});
      await runCommand("systemctl", ["--user", previous.at(-1).content ? "restart" : "stop", paths.hubServiceName]).catch(() => {});
      throw error;
    }
    return { url: `http://127.0.0.1:${hubPort}`, backup };
  });
}

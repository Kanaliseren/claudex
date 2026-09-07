import { readFile } from "node:fs/promises";
import { renderProxyConfig } from "./config.js";
import { loadState, saveState } from "./state.js";
import { atomicWrite, exists, withFileLock } from "./util.js";
import { writeClaudeWrapper } from "./wrapper.js";

// A second Unix user on the same server can use the owner proxy without duplicating OAuth tokens.
export async function connectShared(paths, manifest, connection, { fetchImpl = fetch } = {}) {
  const { port, proxyKey, managementKey } = connection;
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof proxyKey !== "string" || !proxyKey || typeof managementKey !== "string" || !managementKey) {
    throw new Error("shared connection requires a local port, proxyKey, and managementKey");
  }
  return withFileLock(paths.lockFile, async () => {
    const state = await loadState(paths);
    if (state.activeRelease || await exists(paths.systemdUnit) || await exists(paths.launchdPlist)) {
      throw new Error("cannot replace an owned proxy with a shared connection");
    }
    if (!state.sharedProxy && await exists(paths.proxyConfig)) {
      throw new Error("existing proxy configuration must be migrated explicitly");
    }
    const url = `http://127.0.0.1:${port}`;
    for (const [path, key] of [["/v1/models", proxyKey], ["/v0/management/auth-files", managementKey]]) {
      const response = await fetchImpl(`${url}${path}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`shared proxy ${path} returned HTTP ${response.status}`);
    }
    // Mark ownership before creating a usable config, so an interrupted connection cannot start a proxy.
    await saveState(paths, { ...state, sharedProxy: true, sharedProxyUrl: url });
    await atomicWrite(paths.proxyConfig, renderProxyConfig({
      paths, manifest, port, proxyKey, dashboard: true, managementKey, sessionAffinity: true,
    }), 0o600);
    await atomicWrite(paths.dashboardKey, `${managementKey}\n`, 0o600);
    await writeClaudeWrapper(paths, manifest);
    return { url, wrapper: paths.wrapper };
  });
}

export async function connectSharedFile(paths, manifest, path) {
  if (!path) throw new Error("usage: claudex connect --file PATH");
  return connectShared(paths, manifest, JSON.parse(await readFile(path, "utf8")));
}

export async function assertOwnedProxy(paths) {
  if ((await loadState(paths)).sharedProxy) {
    throw new Error("this client uses a shared proxy; manage updates, routing and provider logins from the owner's dashboard or account");
  }
}

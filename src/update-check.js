import { readFile } from "node:fs/promises";
import { readProxyKey, readProxyOptions, readProxySummary, renderProxyConfig } from "./config.js";
import { assetForPlatform } from "./manifest.js";
import { loadState } from "./state.js";
import { exists, sha256File } from "./util.js";

// Compare only with this package's tested channel; never fetch or activate upstream builds.
export async function checkUpdate(paths, manifest, { target } = {}) {
  const asset = assetForPlatform(manifest, target);
  const state = await loadState(paths);
  const installed = await exists(paths.currentBinary);
  const binaryMatchesChannel = installed
    ? (await sha256File(paths.currentBinary)) === asset.sha256
    : false;
  let configMatchesChannel = false;
  if (await exists(paths.proxyConfig)) {
    const summary = await readProxySummary(paths.proxyConfig);
    const proxyKey = await readProxyKey(paths.proxyConfig);
    const expected = renderProxyConfig({ paths, manifest, port: summary.port, proxyKey, ...(await readProxyOptions(paths.proxyConfig)) });
    // Upstream removes blank lines when persisting its bcrypt management-key hash.
    const withoutBlankLines = (text) => text.split("\n").filter((line) => line.trim() !== "").join("\n");
    configMatchesChannel = withoutBlankLines(await readFile(paths.proxyConfig, "utf8")) === withoutBlankLines(expected);
  }
  return {
    installed,
    installedVersion: state.activeRelease?.version ?? null,
    channelVersion: manifest.proxy.version,
    binaryMatchesChannel,
    configMatchesChannel,
    action: !installed ? "setup" : binaryMatchesChannel && configMatchesChannel ? "none" : "update",
  };
}

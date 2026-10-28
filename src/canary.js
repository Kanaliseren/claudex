import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { renderProxyConfig } from "./config.js";
import { atomicWrite, ensureDir, randomSecret, sleep } from "./util.js";

// Boots a candidate binary against an empty auth directory, so no credential is ever exposed to it.
export async function runIsolatedCanary(binary, paths, manifest, { fetchImpl = fetch } = {}) {
  const root = await mkdtemp(join(tmpdir(), "claudex-canary-"));
  const authDir = join(root, "auth");
  const configPath = join(root, "config.yaml");
  await ensureDir(authDir);
  const port = await availablePort();
  const proxyKey = randomSecret("canary");
  await atomicWrite(configPath, renderProxyConfig({ paths: { ...paths, authDir }, manifest, port, proxyKey }), 0o600);

  const child = spawn(binary, ["-config", configPath], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnError;
  child.once("error", (error) => (spawnError = error));
  try {
    await waitForModels(port, proxyKey, child, fetchImpl, () => spawnError);
    return { passed: true, port };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForModels(port, proxyKey, child, fetchImpl, spawnError) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnError()) throw spawnError();
    if (child.exitCode !== null) throw new Error(`canary proxy exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${proxyKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = new Error(`model probe returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`canary proxy did not become ready: ${lastError?.message ?? "unknown error"}`);
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

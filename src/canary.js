import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readProxyOptions, renderProxyConfig, tapVerified } from "./config.js";
import { atomicWrite, ensureDir, randomSecret, sleep } from "./util.js";

// Boots a candidate binary against an empty auth directory, so no credential is ever exposed to it.
// With request logging on, it first tries the candidate with claudex-tap and reports whether the
// host registered it. A missing, changed or incompatible tap never fails the canary: the candidate
// is then checked without plugins and logging is paused on activation.
export async function runIsolatedCanary(binary, paths, manifest, { fetchImpl = fetch } = {}) {
  if (!(await readProxyOptions(paths.proxyConfig)).requestLog) return bootCanary(binary, paths, manifest, { fetchImpl });
  if (!(await tapVerified(paths, manifest))) {
    return { ...(await bootCanary(binary, paths, manifest, { fetchImpl })), requestLog: "unavailable" };
  }
  try {
    const result = await bootCanary(binary, paths, manifest, { fetchImpl, withTap: true });
    if (result.tapRegistered) return { passed: true, port: result.port, requestLog: "ok" };
  } catch {}
  return { ...(await bootCanary(binary, paths, manifest, { fetchImpl })), requestLog: "incompatible" };
}

async function bootCanary(binary, paths, manifest, { fetchImpl, withTap = false }) {
  const root = await mkdtemp(join(tmpdir(), "claudex-canary-"));
  const authDir = join(root, "auth");
  const configPath = join(root, "config.yaml");
  await ensureDir(authDir);
  const port = await availablePort();
  const proxyKey = randomSecret("canary");
  // Nothing listens on the canary's tap socket, so the tap just drops events.
  const canaryPaths = { ...paths, authDir, tapSocket: join(root, "tap.sock") };
  await atomicWrite(configPath, renderProxyConfig({ paths: canaryPaths, manifest, port, proxyKey, requestLog: withTap }), 0o600);

  // The host copies plugins into TMPDIR before loading them; keep that copy owner-only.
  const child = spawn(binary, ["-config", configPath], {
    cwd: root,
    env: { ...process.env, TMPDIR: root },
    stdio: ["ignore", withTap ? "pipe" : "ignore", withTap ? "pipe" : "ignore"],
    windowsHide: true,
  });
  let log = "";
  const collect = (chunk) => {
    if (log.length < 1_000_000) log += chunk;
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let spawnError;
  child.once("error", (error) => (spawnError = error));
  try {
    await waitForModels(port, proxyKey, child, fetchImpl, () => spawnError);
    if (!withTap) return { passed: true, port };
    for (let attempt = 0; attempt < 50 && !tapRegistered(log); attempt += 1) await sleep(100);
    return { passed: true, port, tapRegistered: tapRegistered(log) };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

// The host logs this only after it validated the tap's metadata and capabilities.
function tapRegistered(log) {
  return /plugin registered plugin_id=claudex-tap\b/.test(log);
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

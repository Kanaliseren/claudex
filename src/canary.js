import { createServer } from "node:net";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { renderProxyConfig } from "./config.js";
import { atomicWrite, ensureDir, randomSecret, sleep } from "./util.js";

export async function runIsolatedCanary(binary, paths, manifest, { fetchImpl = fetch, requireOAuth = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "claudex-canary-"));
  const authDir = join(root, "auth");
  const configPath = join(root, "config.yaml");
  await ensureDir(authDir);
  const hasOAuth = await copyAccessOnlyCredential(paths.authDir, authDir);
  if (requireOAuth && !hasOAuth) {
    await rm(root, { recursive: true, force: true });
    throw new Error("a local Codex OAuth credential is required to canary an upstream update; run claudex login codex");
  }
  const port = await availablePort();
  const proxyKey = randomSecret("canary");
  const canaryPaths = { ...paths, authDir };
  await atomicWrite(configPath, renderProxyConfig({ paths: canaryPaths, manifest, port, proxyKey }), 0o600);

  const child = spawn(binary, ["-config", configPath], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
  });
  let spawnError;
  child.once("error", (error) => (spawnError = error));
  try {
    const expectedModels = hasOAuth ? [manifest.models.sol.alias, manifest.models.terra.alias] : [];
    const models = await waitForModels(port, proxyKey, child, fetchImpl, () => spawnError, expectedModels);
    if (hasOAuth) {
      const names = extractModelNames(models);
      for (const model of [manifest.models.sol.alias, manifest.models.terra.alias]) {
        if (!names.has(model)) throw new Error(`canary model list is missing ${model}`);
      }
    }
    if (hasOAuth) await probeOAuthMessage(port, proxyKey, manifest.models.terra.alias, fetchImpl);
    return { passed: true, oauthTested: hasOAuth, port };
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

async function copyAccessOnlyCredential(sourceDir, destinationDir) {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const source = join(sourceDir, entry.name);
    let credential;
    try {
      credential = JSON.parse(await readFile(source, "utf8"));
    } catch {
      continue;
    }
    if (credential.type !== "codex" || credential.disabled) continue;
    delete credential.refresh_token;
    if (credential.tokens && typeof credential.tokens === "object") delete credential.tokens.refresh_token;
    if (!credential.access_token && !credential.tokens?.access_token) continue;
    await atomicWrite(join(destinationDir, entry.name), `${JSON.stringify(credential)}\n`, 0o600);
    return true;
  }
  return false;
}

async function waitForModels(port, proxyKey, child, fetchImpl, spawnError, expectedModels) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnError()) throw spawnError();
    if (child.exitCode !== null) throw new Error(`canary proxy exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: `Bearer ${proxyKey}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const body = await response.json();
        const names = extractModelNames(body);
        const missing = expectedModels.filter((model) => !names.has(model));
        if (missing.length === 0) return body;
        lastError = new Error(`model list is still loading: ${missing.join(", ")}`);
      }
      else lastError = new Error(`model probe returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`canary proxy did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function probeOAuthMessage(port, proxyKey, model, fetchImpl) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": proxyKey,
    },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply only OK." }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    throw new Error(`Codex OAuth canary returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!Array.isArray(body.content) || body.content.length === 0) {
    throw new Error("OAuth canary returned no Claude content");
  }
}

function extractModelNames(body) {
  return new Set((body?.data ?? []).map((model) => model.id).filter(Boolean));
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

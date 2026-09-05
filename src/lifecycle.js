import { readFile } from "node:fs/promises";
import { atomicWrite, ensureDir, exists, run, withFileLock } from "./util.js";
import { activateRelease, stageRelease } from "./binary.js";
import { runIsolatedCanary } from "./canary.js";
import { readProxyKey, readProxySummary, writeProxyConfig } from "./config.js";
import { installService, restartService, stopService } from "./service.js";
import { loadState, saveState } from "./state.js";
import { writeClaudeWrapper } from "./wrapper.js";

export async function setup(paths, manifest, options = {}) {
  return withFileLock(paths.lockFile, async () => {
    await prepareDirectories(paths);
    const release = await stageRelease(paths, manifest, options);
    await writeProxyConfig(paths, manifest, { port: options.port ?? 8317 });
    await activateRelease(paths, release);
    await writeClaudeWrapper(paths, manifest);
    const oldState = await loadState(paths);
    const state = transitionState(oldState, release);
    await saveState(paths, state);
    let service = { kind: "none", installed: false };
    if (!options.noService) {
      try {
        service = await installService(paths, options);
        await waitForLiveProxy(paths);
      } catch (error) {
        if (oldState.activeRelease) {
          await activateRelease(paths, oldState.activeRelease).catch(() => {});
          await saveState(paths, oldState).catch(() => {});
          await restartService(paths, options).catch(() => {});
        } else {
          await stopService(paths, options).catch(() => {});
        }
        throw error;
      }
    }
    return { release, service, config: paths.proxyConfig, wrapper: paths.wrapper };
  });
}

export async function upgrade(paths, manifest, options = {}) {
  return withFileLock(paths.lockFile, async () => {
    await prepareDirectories(paths);
    const oldState = await loadState(paths);
    if (!oldState.activeRelease) throw new Error("run setup before upgrade");
    if (olderRelease(manifest.proxy.version, oldState.activeRelease.version)) {
      throw new Error("refusing to replace a newer installed proxy with an older channel; use update --upstream or rollback explicitly");
    }
    const oldConfig = await readFile(paths.proxyConfig, "utf8");
    const { port } = await readProxySummary(paths.proxyConfig);
    const release = await stageRelease(paths, manifest, options);
    if (release.sha256 === oldState.activeRelease.sha256) {
      try {
        await writeProxyConfig(paths, manifest, { port });
        const configChanged = (await readFile(paths.proxyConfig, "utf8")) !== oldConfig;
        if (configChanged && (await restartService(paths, options))) await waitForLiveProxy(paths);
        await writeClaudeWrapper(paths, manifest);
        return { changed: false, configChanged, release, canary: null };
      } catch (error) {
        await atomicWrite(paths.proxyConfig, oldConfig, 0o600).catch(() => {});
        await restartService(paths, options).catch(() => {});
        throw error;
      }
    }
    const canary = await runIsolatedCanary(release.path, paths, manifest, options);
    const nextState = transitionState(oldState, release);
    try {
      await activateRelease(paths, release);
      await writeProxyConfig(paths, manifest, { port });
      await saveState(paths, nextState);
      if (await restartService(paths, options)) await waitForLiveProxy(paths);
      await writeClaudeWrapper(paths, manifest);
    } catch (error) {
      await activateRelease(paths, oldState.activeRelease).catch(() => {});
      await atomicWrite(paths.proxyConfig, oldConfig, 0o600).catch(() => {});
      await saveState(paths, oldState).catch(() => {});
      await restartService(paths, options).catch(() => {});
      throw new Error(`upgrade smoke test failed and was rolled back: ${error.message}`);
    }
    return { changed: true, configChanged: true, release, canary };
  });
}

function olderRelease(candidate, installed) {
  const versionParts = (version) => /^v(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version)?.slice(1).map(Number);
  const next = versionParts(candidate);
  const current = versionParts(installed);
  if (!next || !current) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== current[index]) return next[index] < current[index];
  }
  return false;
}

export async function rollback(paths, options = {}) {
  return withFileLock(paths.lockFile, async () => {
    const state = await loadState(paths);
    if (!state.previousRelease) throw new Error("no previous release is available for rollback");
    if (!(await exists(state.previousRelease.path))) {
      throw new Error(`previous release binary is missing: ${state.previousRelease.path}`);
    }
    const current = state.activeRelease;
    await activateRelease(paths, state.previousRelease);
    const nextState = {
      ...state,
      activeRelease: state.previousRelease,
      previousRelease: current,
      updatedAt: new Date().toISOString(),
    };
    await saveState(paths, nextState);
    if (await restartService(paths, options)) await waitForLiveProxy(paths);
    return nextState.activeRelease;
  });
}

export async function updateClaudeCode({
  runCommand = run,
  binary = process.env.CLAUDE_CODE_BINARY || "claude",
} = {}) {
  const update = await runCommand(binary, ["update"], {
    allowFailure: true,
    timeout: 10 * 60_000,
  });
  if (update.code !== 0) {
    throw new Error(`Claude Code update failed: ${update.stderr.trim() || `exit ${update.code}`}`);
  }
  const versionResult = await runCommand(binary, ["--version"], {
    allowFailure: true,
    timeout: 15_000,
  });
  if (versionResult.code !== 0) throw new Error("Claude Code update completed but its version could not be read");
  const version = `${versionResult.stdout} ${versionResult.stderr}`.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0];
  if (!version) throw new Error("Claude Code update completed but returned an unknown version");
  return { version };
}

export async function login(paths, { provider = "codex", device = false, runCommand = run } = {}) {
  if (!(await exists(paths.currentBinary)) || !(await exists(paths.proxyConfig))) {
    throw new Error("run setup before login");
  }
  if (!new Set(["codex", "claude"]).has(provider)) {
    throw new Error("login provider must be codex or claude");
  }
  if (provider === "claude" && device) {
    throw new Error("device login is only supported for Codex");
  }
  await ensureDir(paths.authDir);
  const flag = provider === "claude" ? "-claude-login" : device ? "-codex-device-login" : "-codex-login";
  const result = await runCommand(paths.currentBinary, ["-config", paths.proxyConfig, flag], {
    stdio: "inherit",
    timeout: 10 * 60_000,
    allowFailure: true,
  });
  const displayName = provider === "claude" ? "Claude" : "Codex";
  if (result.code !== 0) throw new Error(`${displayName} OAuth login failed with exit ${result.code}`);
  return true;
}

function transitionState(state, release) {
  const changed = state.activeRelease?.sha256 !== release.sha256;
  return {
    ...state,
    activeRelease: release,
    previousRelease: changed ? state.activeRelease ?? state.previousRelease : state.previousRelease,
    updatedAt: new Date().toISOString(),
  };
}

async function prepareDirectories(paths) {
  for (const path of [paths.configDir, paths.dataDir, paths.stateDir, paths.authDir, paths.releasesDir]) {
    await ensureDir(path);
  }
}

async function waitForLiveProxy(paths, { fetchImpl = fetch } = {}) {
  const summary = await readProxySummary(paths.proxyConfig);
  const key = await readProxyKey(paths.proxyConfig);
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetchImpl(`http://${summary.host}:${summary.port}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`proxy did not become healthy: ${lastError?.message ?? "unknown error"}`);
}

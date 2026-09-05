import { readdir, readFile, stat } from "node:fs/promises";
import { inspectBinary } from "./binary.js";
import { readProxyKey, readProxySummary } from "./config.js";
import { serviceStatus } from "./service.js";
import { loadState } from "./state.js";
import { exists, run, sha256File } from "./util.js";

export async function diagnose(paths, manifest, { live = false, fetchImpl = fetch, runCommand = run } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const state = await loadState(paths).catch((error) => {
    add("state", "fail", error.message);
    return { schemaVersion: 1 };
  });

  let summary;
  if (!(await exists(paths.proxyConfig))) {
    add("config", "fail", `missing: ${paths.proxyConfig}`);
  } else {
    try {
      summary = await readProxySummary(paths.proxyConfig);
      const safe =
        summary.host === "127.0.0.1" &&
        summary.remoteManagementDisabled &&
        summary.tlsDisabled &&
        Number.isInteger(summary.port) &&
        summary.port > 0;
      add(
        "config",
        safe ? "pass" : "fail",
        safe ? `loopback-only on ${summary.host}:${summary.port}` : "unsafe or malformed proxy configuration",
      );
      await checkMode(paths.proxyConfig, 0o600, "config permissions", add);
    } catch (error) {
      add("config", "fail", error.message);
    }
  }

  if (!(await exists(paths.currentBinary))) {
    add("binary", "fail", `missing: ${paths.currentBinary}`);
  } else {
    try {
      const inspection = await inspectBinary(paths.currentBinary, manifest, { runCommand });
      const matches = !state.activeRelease?.sha256 || state.activeRelease.sha256 === inspection.sha256;
      const version = state.activeRelease?.version ?? manifest.proxy.version;
      add("binary", matches ? "pass" : "fail", `${inspection.sha256.slice(0, 12)} (${version})`);
    } catch (error) {
      add("binary", "fail", error.message);
    }
  }

  const credentials = await credentialSummary(paths.authDir);
  add(
    "oauth",
    credentials.codex > 0 && credentials.claude > 0 ? "pass" : "warn",
    `local credentials: Codex ${credentials.codex}, Claude ${credentials.claude}`,
  );
  for (const insecure of credentials.insecure) add("oauth permissions", "fail", insecure);

  const claude = await claudeSummary(manifest, runCommand);
  add("claude", claude.status, claude.detail);

  const service = await serviceStatus(paths, { runCommand }).catch((error) => ({ error: error.message }));
  if (service.error) add("service", "warn", service.error);
  else if (!service.installed) add("service", "warn", "not installed; foreground use only");
  else add("service", service.active ? "pass" : "fail", `${service.kind} is ${service.active ? "active" : "inactive"}`);

  if (live && summary) {
    try {
      const key = await readProxyKey(paths.proxyConfig);
      const response = await fetchImpl(`http://${summary.host}:${summary.port}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const names = new Set((body?.data ?? []).map((model) => model.id));
      const expected = ["astra", "sol", "opus", "fable"].map((model) => manifest.models[model].alias);
      const missing = expected.filter((model) => !names.has(model));
      if (missing.length > 0) throw new Error(`missing model aliases: ${missing.join(", ")}`);
      add("live proxy", "pass", `${body.data.length} models; OAuth aliases present`);
    } catch (error) {
      add("live proxy", "fail", error.message);
    }
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checks,
    state: {
      activeVersion: state.activeRelease?.version ?? null,
      activeSha256: state.activeRelease?.sha256 ?? null,
      previousVersion: state.previousRelease?.version ?? null,
    },
  };
}

export async function statusSummary(paths, { runCommand = run } = {}) {
  const state = await loadState(paths);
  const service = await serviceStatus(paths, { runCommand });
  return {
    activeRelease: state.activeRelease ?? null,
    previousRelease: state.previousRelease ?? null,
    service,
    config: paths.proxyConfig,
    wrapper: paths.wrapper,
  };
}

async function credentialSummary(authDir) {
  if (!(await exists(authDir))) return { codex: 0, claude: 0, insecure: [] };
  const insecure = [];
  const providers = { codex: 0, claude: 0 };
  for (const entry of await readdir(authDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = `${authDir}/${entry.name}`;
    try {
      const credential = JSON.parse(await readFile(path, "utf8"));
      if (!(credential.type in providers)) continue;
      providers[credential.type] += 1;
    } catch {
      continue;
    }
    if (process.platform !== "win32") {
      const metadata = await stat(path);
      if ((metadata.mode & 0o077) !== 0) insecure.push(`${entry.name} is readable outside the user account`);
    }
  }
  return { ...providers, insecure };
}

async function checkMode(path, expected, name, add) {
  if (process.platform === "win32") return;
  const metadata = await stat(path);
  const actual = metadata.mode & 0o777;
  add(name, actual === expected ? "pass" : "fail", `${actual.toString(8)} (expected ${expected.toString(8)})`);
}

async function claudeSummary(manifest, runCommand) {
  const binary = process.env.CLAUDE_CODE_BINARY || "claude";
  try {
    const [versionResult, helpResult] = await Promise.all([
      runCommand(binary, ["--version"], { allowFailure: true, timeout: 15_000 }),
      runCommand(binary, ["--help"], { allowFailure: true, timeout: 15_000 }),
    ]);
    if (versionResult.code !== 0 || helpResult.code !== 0) throw new Error("Claude Code command failed");
    const versionText = `${versionResult.stdout} ${versionResult.stderr}`.trim();
    const version = versionText.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? "unknown";
    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    const missing = manifest.compatibility.claudeCode.requiredCapabilities.filter((flag) => !help.includes(flag));
    if (missing.length > 0) return { status: "fail", detail: `${version}; missing ${missing.join(", ")}` };
    if (!manifest.compatibility.claudeCode.tested.includes(version)) {
      return { status: "warn", detail: `${version}; untested, proxy ToolSearch override remains enabled` };
    }
    return { status: "pass", detail: `${version}; compatibility-tested` };
  } catch (error) {
    return { status: "warn", detail: `not available (${error.message})` };
  }
}

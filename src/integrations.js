import { copyFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { atomicWrite, ensureDir, exists, readJson } from "./util.js";
import { claudeEnvironment } from "./wrapper.js";

export async function integrate(paths, manifest, target, { path, home = paths.userHome } = {}) {
  if (!new Set(["paseo", "t3", "all"]).has(target)) {
    throw new Error("integration target must be paseo, t3, or all");
  }
  const results = [];
  if (target === "paseo" || target === "all") {
    results.push(await integratePaseo(paths, manifest, path ?? join(home, ".paseo", "config.json")));
  }
  if (target === "t3" || target === "all") {
    if (target === "all" && path) throw new Error("--path cannot be used with integration target all");
    results.push(
      await integrateT3(paths, manifest, path ?? join(home, ".t3", "userdata", "settings.json")),
    );
  }
  return results;
}

export async function integratePaseo(paths, manifest, configPath) {
  const config = await loadExistingConfig(configPath, "Paseo");
  const provider = config?.agents?.providers?.claude;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error("unsupported Paseo config: agents.providers.claude is missing");
  }
  if (provider.env !== undefined && (!provider.env || typeof provider.env !== "object" || Array.isArray(provider.env))) {
    throw new Error("unsupported Paseo config: Claude provider env must be an object");
  }
  const env = await claudeEnvironment(paths, manifest);
  provider.command = paths.wrapper;
  provider.env = {
    ...(provider.env ?? {}),
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    API_TIMEOUT_MS: env.API_TIMEOUT_MS,
  };
  const backup = await backupAndWrite(paths, configPath, config, 0o600);
  return { target: "paseo", path: configPath, backup };
}

export async function integrateT3(paths, manifest, configPath) {
  const config = await loadExistingConfig(configPath, "T3 Code");
  const provider = config?.providerInstances?.claudeAgent;
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new Error("unsupported T3 Code config: providerInstances.claudeAgent is missing");
  }
  if (!Array.isArray(provider.environment)) {
    throw new Error("unsupported T3 Code config: Claude provider environment must be an array");
  }
  if (provider.environment.some((entry) => !entry || typeof entry.name !== "string")) {
    throw new Error("unsupported T3 Code config: malformed Claude environment entry");
  }
  if (provider.config !== undefined && (!provider.config || typeof provider.config !== "object" || Array.isArray(provider.config))) {
    throw new Error("unsupported T3 Code config: Claude provider config must be an object");
  }
  if (provider.config?.customModels !== undefined && (!Array.isArray(provider.config.customModels) || provider.config.customModels.some((model) => typeof model !== "string" || !model))) {
    throw new Error("unsupported T3 Code config: Claude customModels must contain model names");
  }
  const env = await claudeEnvironment(paths, manifest);
  const nativeModels = Object.values(manifest.models)
    .filter((model) => model.upstream === model.alias)
    .map((model) => model.alias);
  provider.config = {
    ...(provider.config ?? {}),
    customModels: [...new Set([...(provider.config?.customModels ?? []), ...nativeModels])],
  };
  for (const name of [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ENABLE_TOOL_SEARCH",
    "API_TIMEOUT_MS",
  ]) {
    provider.environment = upsertEnvironment(provider.environment, name, env[name], false);
  }
  provider.environment = upsertEnvironment(
    provider.environment,
    "ANTHROPIC_AUTH_TOKEN",
    env.ANTHROPIC_AUTH_TOKEN,
    true,
  );
  provider.environment = upsertEnvironment(
    provider.environment,
    "ANTHROPIC_API_KEY",
    env.ANTHROPIC_AUTH_TOKEN,
    true,
  );
  const backup = await backupAndWrite(paths, configPath, config, 0o600);
  return { target: "t3", path: configPath, backup };
}

function upsertEnvironment(environment, name, value, sensitive) {
  const next = environment.map((entry) => ({ ...entry }));
  const existing = next.find((entry) => entry.name === name);
  if (existing) {
    existing.value = value;
    existing.sensitive = sensitive;
    if (sensitive && "valueRedacted" in existing) existing.valueRedacted = true;
  } else {
    next.push({ name, value, sensitive, ...(sensitive ? { valueRedacted: true } : {}) });
  }
  return next;
}

async function loadExistingConfig(path, product) {
  if (!(await exists(path))) throw new Error(`${product} config not found: ${path}`);
  return readJson(path);
}

async function backupAndWrite(paths, path, value, outputMode) {
  const metadata = await stat(path);
  const suffix = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const directory = join(paths.backupsDir, basename(dirname(path)));
  await ensureDir(directory);
  const backup = join(directory, `${basename(path)}.${suffix}.bak`);
  await copyFile(path, backup);
  if (process.platform !== "win32") {
    const { chmod } = await import("node:fs/promises");
    await chmod(backup, metadata.mode & 0o777);
  }
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, outputMode ?? (metadata.mode & 0o777));
  return backup;
}

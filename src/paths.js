import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export function resolvePaths({ env = process.env, platform = process.platform, home } = {}) {
  const userHome = home ?? env.HOME ?? homedir();
  const isolated = env.CLAUDEX_HOME ?? env.CLIPROXY_OAUTH_HOME;
  const legacy = !isolated && hasLegacyInstallation({ env, platform, userHome });
  const namespace = legacy ? "cliproxy-oauth" : "claudex";
  let configDir;
  let dataDir;
  let stateDir;
  let binDir;

  if (isolated) {
    configDir = join(isolated, "config");
    dataDir = join(isolated, "data");
    stateDir = join(isolated, "state");
    binDir = join(isolated, "bin");
  } else if (platform === "darwin") {
    const applicationSupport = join(userHome, "Library", "Application Support", namespace);
    configDir = join(userHome, ".config", namespace);
    dataDir = applicationSupport;
    stateDir = join(applicationSupport, "state");
    binDir = join(userHome, ".local", "bin");
  } else if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(userHome, "AppData", "Local");
    configDir = join(local, namespace, "config");
    dataDir = join(local, namespace, "data");
    stateDir = join(local, namespace, "state");
    binDir = join(local, namespace, "bin");
  } else {
    configDir = join(env.XDG_CONFIG_HOME ?? join(userHome, ".config"), namespace);
    dataDir = join(env.XDG_DATA_HOME ?? join(userHome, ".local", "share"), namespace);
    stateDir = join(env.XDG_STATE_HOME ?? join(userHome, ".local", "state"), namespace);
    binDir = join(userHome, ".local", "bin");
  }

  const executable = platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
  return {
    userHome,
    isolated: Boolean(isolated),
    configDir,
    dataDir,
    stateDir,
    binDir,
    proxyConfig: join(configDir, "config.yaml"),
    authDir: join(stateDir, "auth"),
    releasesDir: join(dataDir, "releases"),
    currentDir: join(dataDir, "current"),
    currentBinary: join(dataDir, "current", executable),
    executable,
    wrapper: join(binDir, platform === "win32" ? "claude-cliproxy.cmd" : "claude-cliproxy"),
    stateFile: join(stateDir, "state.json"),
    lockFile: join(stateDir, "operation.lock"),
    backupsDir: join(stateDir, "backups"),
    serviceName: `${namespace}.service`,
    launchdLabel: `com.kanaliseren.${namespace}`,
    systemdUnit: join(userHome, ".config", "systemd", "user", `${namespace}.service`),
    hubServiceName: `${namespace}-hub.service`,
    hubSystemdUnit: join(userHome, ".config", "systemd", "user", `${namespace}-hub.service`),
    launchdPlist: join(userHome, "Library", "LaunchAgents", `com.kanaliseren.${namespace}.plist`),
  };
}

function hasLegacyInstallation({ env, platform, userHome }) {
  if (platform === "darwin") {
    return [
      join(userHome, "Library", "Application Support", "cliproxy-oauth"),
      join(userHome, ".config", "cliproxy-oauth"),
      join(userHome, "Library", "LaunchAgents", "com.kanaliseren.cliproxy-oauth.plist"),
    ].some(existsSync);
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(userHome, "AppData", "Local");
    return existsSync(join(local, "cliproxy-oauth"));
  }
  return [
    join(env.XDG_CONFIG_HOME ?? join(userHome, ".config"), "cliproxy-oauth"),
    join(env.XDG_DATA_HOME ?? join(userHome, ".local", "share"), "cliproxy-oauth"),
    join(userHome, ".config", "systemd", "user", "cliproxy-oauth.service"),
  ].some(existsSync);
}

export function platformKey({ platform = process.platform, arch = process.arch } = {}) {
  const supported = new Set(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]);
  const key = `${platform}-${arch}`;
  if (!supported.has(key)) throw new Error(`unsupported platform: ${key}`);
  return key;
}

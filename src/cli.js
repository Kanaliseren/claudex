import { loadManifest } from "./manifest.js";
import { resolvePaths } from "./paths.js";
import { diagnose, statusSummary } from "./doctor.js";
import { integrate } from "./integrations.js";
import { login, rollback, setup, updateClaudeCode, upgrade } from "./lifecycle.js";
import { runClaude } from "./wrapper.js";
import { checkUpdate } from "./update-check.js";
import { prepareUpstreamManifest } from "./promotion.js";
import { readQuotaHubConfig } from "./config.js";
import { configure, dashboardSummary } from "./settings.js";
import { assertOwnedProxy, connectSharedFile } from "./shared.js";

export async function main(argv = process.argv.slice(2), io = console) {
  const [command = "help", ...tail] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    io.log(helpText);
    return 0;
  }
  if (command === "claude" || command === "run") {
    const manifest = await loadManifest();
    const paths = resolvePaths();
    let args = tail;
    let model;
    if (command === "run") {
      const [name, ...rest] = tail;
      if (!Object.hasOwn(manifest.models, name)) {
        throw new Error(`usage: claudex run <${Object.keys(manifest.models).join("|")}> [--] [CLAUDE OPTIONS...]`);
      }
      model = manifest.models[name].upstream;
      args = rest;
    }
    args = args[0] === "--" ? args.slice(1) : args;
    if (model) args = ["--model", model, ...args];
    return runClaude(paths, manifest, args);
  }
  const parsed = parseArguments(tail);
  if (parsed.options.check && command !== "update" && command !== "upgrade") {
    throw new Error("--check is only supported by update and upgrade");
  }
  if (parsed.options.upstream && command !== "update" && command !== "upgrade") {
    throw new Error("--upstream is only supported by update and upgrade");
  }
  const manifest = await loadManifest(parsed.options.manifest);
  const paths = resolvePaths();

  if (command === "connect") {
    rejectPositionals(parsed, command);
    const result = await connectSharedFile(paths, manifest, parsed.options.file);
    io.log(`Connected to shared proxy: ${result.url}`);
    io.log("Next: claudex integrate t3 --with-hub");
    return 0;
  }

  if (command === "configure" || command === "dashboard") {
    rejectPositionals(parsed, command);
    if (parsed.options.dashboard && parsed.options.noDashboard) throw new Error("choose --dashboard or --no-dashboard");
    if (parsed.options.sessionAffinity && parsed.options.noSessionAffinity) throw new Error("choose one session-affinity option");
    const settings = command === "configure"
      ? await configure(paths, manifest, {
        dashboard: parsed.options.dashboard ? true : parsed.options.noDashboard ? false : undefined,
        sessionAffinity: parsed.options.sessionAffinity ? true : parsed.options.noSessionAffinity ? false : undefined,
        strategy: parsed.options.strategy,
      })
      : await dashboardSummary(paths);
    if (parsed.options.json) io.log(JSON.stringify(settings, null, 2));
    else {
      io.log(`Dashboard: ${settings.enabled ? settings.url : "disabled"}`);
      if (settings.enabled) io.log(`Management key file (keep private): ${settings.keyFile}`);
      io.log(`Routing: ${settings.strategy}; session affinity: ${settings.sessionAffinity ? "enabled" : "disabled"}`);
      if (settings.restarted === false) io.log("Restart the foreground proxy to apply these settings.");
    }
    return 0;
  }

  if (command === "models") {
    rejectPositionals(parsed, command);
    const models = Object.entries(manifest.models).map(([name, model]) => ({
      name,
      alias: model.alias,
      upstream: model.upstream,
      displayName: model.displayName ?? name,
    }));
    if (parsed.options.json) io.log(JSON.stringify(models, null, 2));
    else {
      io.log("Models in the bundled tested channel (availability requires local provider login):");
      for (const model of models) io.log(`${model.name.padEnd(7)} ${model.alias} -> ${model.upstream}`);
    }
    return 0;
  }

  if (command === "hub") {
    rejectPositionals(parsed, command);
    const hub = await readQuotaHubConfig(paths.hubConfig);
    const summary = { url: `http://${hub.host}:${hub.port}` };
    if (parsed.options.json) io.log(JSON.stringify(summary, null, 2));
    else io.log(`Hub URL: ${summary.url}`);
    return 0;
  }

  if (command === "setup") {
    rejectPositionals(parsed, command);
    const result = await setup(paths, manifest, {
      binary: parsed.options.binary,
      port: numberOption(parsed.options.port, "port"),
      noService: Boolean(parsed.options.noService),
    });
    io.log(`Installed ${result.release.version} (${result.release.sha256.slice(0, 12)}).`);
    io.log(`Config: ${result.config}`);
    io.log(`Claude wrapper: ${result.wrapper}`);
    if (!result.service.installed) io.log("Service was not installed; start the proxy before live use.");
    io.log("Next: claudex login codex && claudex login claude");
    return 0;
  }

  if (command === "login") {
    const [provider = "codex", ...extra] = parsed.positionals;
    if (extra.length > 0 || !new Set(["codex", "claude"]).has(provider)) {
      throw new Error("usage: claudex login [codex|claude] [--device]");
    }
    await login(paths, { provider, device: Boolean(parsed.options.device) });
    io.log(`${provider === "claude" ? "Claude" : "Codex"} OAuth login completed locally.`);
    return 0;
  }

  if (command === "doctor") {
    rejectPositionals(parsed, command);
    const report = await diagnose(paths, manifest, { live: Boolean(parsed.options.live) });
    if (parsed.options.json) io.log(JSON.stringify(report, null, 2));
    else printDoctor(report, io);
    return report.ok ? 0 : 1;
  }

  if (command === "status") {
    rejectPositionals(parsed, command);
    const status = await statusSummary(paths);
    if (parsed.options.json) io.log(JSON.stringify(status, null, 2));
    else {
      io.log(`Active: ${status.sharedProxyUrl ? `shared proxy at ${status.sharedProxyUrl}` : status.activeRelease?.version ?? "not installed"}`);
      io.log(`Service: ${status.sharedProxyUrl ? "managed by the proxy owner" : status.service.installed ? (status.service.active ? "active" : "inactive") : "not installed"}`);
      io.log(`Config: ${status.config}`);
      io.log(`Wrapper: ${status.wrapper}`);
    }
    return 0;
  }

  if (command === "update" || command === "upgrade") {
    rejectPositionals(parsed, command);
    await assertOwnedProxy(paths);
    if (parsed.options.upstream && (parsed.options.binary || parsed.options.manifest)) {
      throw new Error("--upstream cannot be combined with --binary or --manifest");
    }
    if (parsed.options.json && !parsed.options.check) throw new Error("--json requires --check for update and upgrade");
    const candidate = parsed.options.upstream
      ? await prepareUpstreamManifest(manifest, "latest", { currentPlatformOnly: true })
      : manifest;
    if (parsed.options.check) {
      if (parsed.options.binary) throw new Error("--binary cannot be combined with --check; checks use the bundled tested channel");
      const report = await checkUpdate(paths, candidate);
      if (parsed.options.json) io.log(JSON.stringify(report, null, 2));
      else {
        io.log(`Installed proxy: ${report.installed ? report.installedVersion ?? "unknown version" : "not installed"}`);
        io.log(`${parsed.options.upstream ? "Official upstream release" : "Bundled tested channel"}: ${report.channelVersion}`);
        io.log(`Binary: ${report.binaryMatchesChannel ? "matches" : "missing or differs"}; config: ${report.configMatchesChannel ? "matches" : "missing or differs"}.`);
        io.log(report.action === "none" ? "Proxy binary and config match this channel." : `Next: claudex ${report.action}${parsed.options.upstream && report.action === "update" ? " --upstream" : ""}`);
        io.log("Read-only check; Claude Code updates and newer Claudex packages are not checked. No provider canary has run.");
      }
      return 0;
    }
    const claude = await updateClaudeCode();
    io.log(`Claude Code is current (${claude.version}).`);
    const result = await upgrade(paths, candidate, { binary: parsed.options.binary, requireOAuth: Boolean(parsed.options.upstream) });
    if (!result.changed) io.log(`Already on ${result.release.version} (${result.release.sha256.slice(0, 12)}).`);
    else {
      io.log(`Upgraded to ${result.release.version} (${result.release.sha256.slice(0, 12)}).`);
      io.log(`Isolated canary: passed${result.canary.oauthTested ? " with local OAuth" : " (no local OAuth credential)"}.`);
    }
    return 0;
  }

  if (command === "rollback") {
    rejectPositionals(parsed, command);
    const release = await rollback(paths);
    io.log(`Rolled back to ${release.version} (${release.sha256.slice(0, 12)}).`);
    return 0;
  }

  if (command === "integrate") {
    const [target, ...extra] = parsed.positionals;
    if (!target || extra.length > 0) throw new Error("usage: claudex integrate <paseo|t3|all> [--path PATH]");
    const results = await integrate(paths, manifest, target, {
      path: parsed.options.path, includeHub: Boolean(parsed.options.withHub), removeHub: Boolean(parsed.options.withoutHub),
    });
    for (const result of results) io.log(`Updated ${result.target}: ${result.path} (backup: ${result.backup})`);
    io.log("No application was restarted; restart it when convenient.");
    return 0;
  }

  throw new Error(`unknown command: ${command}\n\n${helpText}`);
}

const helpText = `claudex — route Claude Code through local Codex and Claude OAuth sessions

Usage:
  claudex setup [--binary PATH] [--port PORT] [--no-service]
  claudex connect --file PATH
  claudex login [codex|claude] [--device]
  claudex doctor [--json] [--live]
  claudex update [--upstream | --binary PATH] [--check [--json]]
  claudex upgrade [--upstream | --binary PATH] [--check [--json]]
  claudex rollback
  claudex integrate <paseo|t3|all> [--path PATH] [--with-hub|--without-hub]
  claudex claude [--] [CLAUDE OPTIONS...]
  claudex run <astra|sol|opus|fable> [--] [CLAUDE OPTIONS...]
  claudex models [--json]
  claudex hub [--json]
  claudex dashboard [--json]
  claudex configure [--dashboard|--no-dashboard] [--session-affinity|--no-session-affinity] [--strategy round-robin|fill-first]
  claudex status [--json]

Environment:
  CLAUDEX_HOME         Isolate every package-owned file under one directory.
  CLIPROXY_OAUTH_HOME  Legacy alias for CLAUDEX_HOME.
  CLAUDE_CODE_BINARY   Override the Claude Code executable.
`;

function parseArguments(args) {
  const options = {};
  const positionals = [];
  const boolean = new Map([
    ["--no-service", "noService"],
    ["--device", "device"],
    ["--json", "json"],
    ["--live", "live"],
    ["--check", "check"],
    ["--upstream", "upstream"],
    ["--with-hub", "withHub"],
    ["--without-hub", "withoutHub"],
    ["--dashboard", "dashboard"],
    ["--no-dashboard", "noDashboard"],
    ["--session-affinity", "sessionAffinity"],
    ["--no-session-affinity", "noSessionAffinity"],
  ]);
  const valued = new Map([
    ["--binary", "binary"],
    ["--port", "port"],
    ["--path", "path"],
    ["--manifest", "manifest"],
    ["--strategy", "strategy"],
    ["--file", "file"],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (boolean.has(value)) options[boolean.get(value)] = true;
    else if (valued.has(value)) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      options[valued.get(value)] = next;
      index += 1;
    } else if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    else positionals.push(value);
  }
  return { options, positionals };
}

function numberOption(value, name) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`invalid ${name}: ${value}`);
  return number;
}

function rejectPositionals(parsed, command) {
  if (parsed.positionals.length > 0) throw new Error(`${command} does not accept positional arguments`);
}

function printDoctor(report, io) {
  for (const check of report.checks) {
    const symbol = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    io.log(`${symbol.padEnd(4)}  ${check.name}: ${check.detail}`);
  }
}

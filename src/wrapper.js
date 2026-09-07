import { atomicWrite, run, shellQuote } from "./util.js";
import { readProxyKey, readProxySummary } from "./config.js";

const identityPrompt =
  "This Claude Code session uses a local CLIProxyAPI OAuth bridge. Preserve Claude Code native tools, subagents, and workflow semantics.";

// Use provider IDs: Claude's built-in Sonnet/Haiku IDs ignore custom context limits.
// Both Codex subscription models use 272K. Claude reserves 20K for output before
// applying 80%, so native compaction starts at about 201,600 occupied tokens.
function modelEnvironment(manifest) {
  const capabilities = "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking";
  return {
    ANTHROPIC_MODEL: manifest.models.astra.upstream,
    ANTHROPIC_DEFAULT_SONNET_MODEL: manifest.models.astra.upstream,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "Sonnet (Astra)",
    ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: capabilities,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: manifest.models.sol.upstream,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "Haiku (Sol)",
    ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: capabilities,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "272000",
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80",
  };
}

export async function writeClaudeWrapper(paths, manifest, { platform = process.platform } = {}) {
  const summary = await readProxySummary(paths.proxyConfig);
  if (platform === "win32") {
    const script = renderWindowsWrapper(paths, manifest, `http://${summary.host}:${summary.port}`);
    await atomicWrite(paths.wrapper, script, 0o700);
    return paths.wrapper;
  }
  const script = renderUnixWrapper(paths, manifest, `http://${summary.host}:${summary.port}`);
  await atomicWrite(paths.wrapper, script, 0o700);
  return paths.wrapper;
}

export async function claudeEnvironment(paths, manifest, { enableToolSearch = true } = {}) {
  const summary = await readProxySummary(paths.proxyConfig);
  const proxyKey = await readProxyKey(paths.proxyConfig);
  return {
    ANTHROPIC_BASE_URL: `http://${summary.host}:${summary.port}`,
    ANTHROPIC_AUTH_TOKEN: proxyKey,
    ...modelEnvironment(manifest),
    ...(enableToolSearch ? { ENABLE_TOOL_SEARCH: "true" } : {}),
    API_TIMEOUT_MS: "3000000",
  };
}

export async function runClaude(paths, manifest, args, { runCommand = run } = {}) {
  const binary = process.env.CLAUDE_CODE_BINARY || "claude";
  const help = await runCommand(binary, ["--help"], { allowFailure: true, timeout: 15_000 });
  if (help.code !== 0) throw new Error(`Claude Code is unavailable: ${help.stderr.trim()}`);
  const supported = `${help.stdout}\n${help.stderr}`;
  const dynamicArgs = [];
  if (supported.includes("--exclude-dynamic-system-prompt-sections")) {
    dynamicArgs.push("--exclude-dynamic-system-prompt-sections");
  }
  if (supported.includes("--append-system-prompt")) {
    dynamicArgs.push("--append-system-prompt", identityPrompt);
  }
  const result = await runCommand(binary, [...dynamicArgs, ...args], {
    env: await claudeEnvironment(paths, manifest),
    stdio: "inherit",
    timeout: 0,
    allowFailure: true,
  });
  return result.code;
}

function renderUnixWrapper(paths, manifest, baseUrl) {
  return `#!/bin/sh
set -eu
claude_binary=\${CLAUDE_CODE_BINARY:-claude}
if ! command -v "$claude_binary" >/dev/null 2>&1; then
  echo "Claude Code is not installed or CLAUDE_CODE_BINARY is invalid" >&2
  exit 127
fi
proxy_key=$(awk '/^api-keys:/{found=1; next} found && /^[[:space:]]*-[[:space:]]*/ {sub(/^[[:space:]]*-[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit}' ${shellQuote(paths.proxyConfig)})
if [ -z "$proxy_key" ]; then
  echo "No proxy key found in ${paths.proxyConfig}" >&2
  exit 1
fi
claude_help=$("$claude_binary" --help 2>&1 || true)
set -- "$@"
case "$claude_help" in *--append-system-prompt*) set -- --append-system-prompt ${shellQuote(identityPrompt)} "$@";; esac
case "$claude_help" in *--exclude-dynamic-system-prompt-sections*) set -- --exclude-dynamic-system-prompt-sections "$@";; esac
export ANTHROPIC_BASE_URL=${shellQuote(baseUrl)}
export ANTHROPIC_AUTH_TOKEN="$proxy_key"
${Object.entries(modelEnvironment(manifest)).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join("\n")}
export ENABLE_TOOL_SEARCH=true
export API_TIMEOUT_MS=3000000
exec "$claude_binary" "$@"
`;
}

function renderWindowsWrapper(paths, manifest, baseUrl) {
  return `@echo off\r
setlocal EnableExtensions EnableDelayedExpansion\r
set "claude_binary=%CLAUDE_CODE_BINARY%"\r
if not defined claude_binary set "claude_binary=claude"\r
set "proxy_key="\r
for /f "tokens=2" %%K in ('findstr /r /c:"^  - " "${paths.proxyConfig}"') do if not defined proxy_key set "proxy_key=%%~K"\r
if not defined proxy_key (echo No proxy key found in ${paths.proxyConfig} 1>&2 & exit /b 1)\r
set "ANTHROPIC_BASE_URL=${baseUrl}"\r
set "ANTHROPIC_AUTH_TOKEN=!proxy_key!"\r
${Object.entries(modelEnvironment(manifest)).map(([name, value]) => `set "${name}=${value}"`).join("\r\n")}\r
set "ENABLE_TOOL_SEARCH=true"\r
set "API_TIMEOUT_MS=3000000"\r
set "dynamic_args="\r
"!claude_binary!" --help 2>&1 | findstr /c:"--exclude-dynamic-system-prompt-sections" >nul && set "dynamic_args=--exclude-dynamic-system-prompt-sections"\r
"!claude_binary!" --help 2>&1 | findstr /c:"--append-system-prompt" >nul && set "dynamic_args=!dynamic_args! --append-system-prompt \"${identityPrompt}\""\r
"!claude_binary!" !dynamic_args! %*\r
exit /b !errorlevel!\r
`;
}

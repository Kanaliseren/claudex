# Claudex on Mac

Repository: https://github.com/Kanaliseren/claudex

Install [Node.js 24](https://nodejs.org/en/download) and Git first. On macOS,
`xcode-select --install` installs Apple's command-line tools, including Git;
finish its installer before continuing.

In Terminal, install [Claude Code](https://code.claude.com/docs/en/setup) if needed:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Install Claudex into your user directory and add its commands to your shell:

```bash
npm install -g --prefix "$HOME/.local" github:Kanaliseren/claudex
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
export PATH="$HOME/.local/bin:$PATH"
claudex setup
claudex login claude
claudex run fable
```

Complete the browser login using your own Claude account. Every model, including
**Haiku**, **Sonnet**, **Opus 5**, and **Fable 5.1**, uses its native Claude route.
Run `claudex login codex` to add a Codex account as well.

For T3 Code, run `claudex integrate t3`, then restart T3 Code.

Claude Code keeps itself current through its native auto-updater. Update Claudex
and the official proxy later with:

```bash
npm install -g --prefix "$HOME/.local" github:Kanaliseren/claudex
claudex update --upstream
```

Share the repository or this guide. Each friend signs in separately; no credential
files or API keys need to be shared.

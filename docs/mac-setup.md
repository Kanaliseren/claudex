# Claudex on Mac

Repository: https://github.com/Kanaliseren/claudex

Install [Node.js 20+](https://nodejs.org/en/download) and Git first. On macOS,
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
claudex login codex
claudex run astra
```

Complete the browser login using your own account with Codex model access.
Sonnet routes to **GPT-6 Astra**; Haiku routes to **GPT-5.6 Sol**.
Use `claudex run sol` to choose Sol directly.

For native **Opus 5** and **Fable 5.1**, add your own Claude login:

```bash
claudex login claude
claudex run fable
```

For T3 Code, run `claudex integrate t3`, then restart T3 Code.

Update Claudex, Claude Code, and the official proxy later with:

```bash
npm install -g --prefix "$HOME/.local" github:Kanaliseren/claudex
claudex update --upstream
```

Share the repository or this guide. Each friend signs in separately; no credential
files or API keys need to be shared.

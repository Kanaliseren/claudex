# Dren's Mac → riz-server Claudex setup

Repository: https://github.com/Kanaliseren/claudex

Claudex runs under your **dren** SSH account on **riz-server**. Your Mac runs T3
Code and connects to that environment. You do not need a second proxy on the Mac.

The client uses the existing shared proxy: **two Claude subscription accounts and
one Codex account**. Provider logins are already managed there. Both people use
the same subscription quotas; the setup does not duplicate their allowances.

## Start using it

1. In T3 Code, connect to **riz-server as dren** and create a new thread there.
2. Select the **Claude** provider. The model routes are:

   | Selection | Actual model |
   |---|---|
   | Sonnet | GPT-6 Astra through Codex |
   | Haiku | GPT-5.6 Sol through Codex |
   | Opus 5 | Native Claude Opus 5 |
   | Fable 5.1 | Native Claude Fable 5.1 |

3. Open **Limits**. The **Claudex** source lists the shared accounts individually.
   Reopen the view after a refresh if you have just connected.

For terminal use, open Terminal on your Mac:

```bash
ssh dren@riz-server
claudex models
claudex run astra
```

Other sessions: `claudex run sol`, `claudex run opus`, or `claudex run fable`.
`claudex claude` uses the Astra default. Use these commands for the bridge;
the plain `claude` command starts the original Claude CLI directly.

## Dashboard

On the Mac, keep this tunnel open in a separate Terminal:

```bash
ssh -o ExitOnForwardFailure=yes -N \
  -L 18317:127.0.0.1:8317 \
  -L 54545:127.0.0.1:54545 \
  dren@riz-server
```

Copy your saved management key to the Mac clipboard from another Terminal:

```bash
ssh dren@riz-server 'cat ~/.config/claudex/dashboard-key' | pbcopy
```

Open http://127.0.0.1:18317/management.html and paste the key. If asked for the API
address, use `http://127.0.0.1:18317`. **Quota Management** shows account usage;
**Auth Files** lists the connected accounts. **OAuth** adds an account to the
shared pool, so changes here affect both users. The existing three accounts need
no new login. Never paste a key or callback URL into chat.

## Updates

In the `dren` SSH session, update the client and refresh its T3 integration:

```bash
npm install -g --prefix "$HOME/.local" github:Kanaliseren/claudex
claudex integrate t3 --with-hub
claude update
claudex doctor --live
```

The shared proxy's owner updates the backend using `claudex update --upstream`
under **nand**. Shared clients reject `setup`, proxy `update`, `configure`, and
CLI provider logins to avoid starting or managing another proxy.

## Connecting another Unix user on this server

Install Node.js 24, Claude Code, and the Claudex package under that user. The proxy
owner must privately provision a mode-0600 JSON file containing `port`, `proxyKey`,
and `managementKey`; these are gateway access keys, not OAuth token files. Then run:

```bash
claudex connect --file /path/to/private-connection.json
claudex integrate t3 --with-hub
```

Delete the temporary connection file after success. Claudex stores the client
configuration privately and leaves OAuth refresh to the single owner proxy.

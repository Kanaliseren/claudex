# Updating Claudex

1. Fast-forward `Kanaliseren/CLIProxyAPI` from upstream and keep the compatibility patch green.
2. Tag it `v<upstream>-claudex.<n>`; CI publishes binaries plus `claudex-assets.json`.
3. Run `npm run promote:proxy -- <tag> --claude <version>` here.
4. Run `npm run check`, `npm run verify:assets`, and a real-OAuth `claudex update` canary.
5. Commit `channel/stable.json`, push, then run `npx --yes github:Kanaliseren/claudex update`.

The promotion script owns release URLs and checksums. Edit model aliases only when a model changes.

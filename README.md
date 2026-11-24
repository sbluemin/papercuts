# Papercuts

Papercuts is a Claude Code plugin for recording small failures and friction with any tool, without a Fleet dependency. A local web dashboard lets you read the reports and update their status. It doesn't automatically capture tool output, file issues, or run an improvement loop.

## Install the plugin

Use a current Claude Code CLI and Node.js **24.12.0 or newer** on your `PATH`. In a terminal:

```sh
claude plugin marketplace add sbluemin/papercuts
claude plugin install papercuts@papercuts
```

Start a new Claude Code session. No npm package or runtime dependency install is needed.

## File a report

Ask Claude explicitly, for example:

> Use Papercuts to report an inefficiency with the Search tool: the results needed several retries. Don't include the actual queries or output. Give me the receipt ID.

`report_papercut` accepts a tool name (or `general`, up to 120 characters), a category (`failure`, `inefficiency`, `confusing`, `missing`, or `other`), a summary (up to 200 characters), and optional details (up to 4,000 characters). A successful call returns a `PC-…` receipt. Use synthetic examples or summarize the problem; don't paste tokens, credentials, private paths, prompts, or raw tool output. Report text isn't automatically redacted.

## Open the local dashboard

```sh
git clone https://github.com/sbluemin/papercuts.git
cd papercuts
npm run dashboard
```

Open **http://127.0.0.1:4317** (or the URL printed at startup). Browse the report list, open a receipt to see its details, and set its status to `new`, `reviewing`, or `resolved`. Changes persist after restart. Stop the server with Ctrl+C. The server listens only on loopback; it is not designed for shared, remote, or proxied access.

## Data and development

- Both processes use `~/.papercuts/reports.sqlite` by default. To isolate a run, set `PAPERCUTS_DATA_DIR` to the same absolute path in the environments that launch Claude Code and the dashboard. Use a private directory outside the Git checkout. The SQLite file is local plaintext, so restrict who can access the directory and its backups.
- Set `PAPERCUTS_PORT` before starting the dashboard to use a different port. The service does not need a GitHub token or a network connection after installation.
- Run `npm test` for automated tests. To try the local plugin without installing it, run `claude --plugin-dir .` from the source checkout.

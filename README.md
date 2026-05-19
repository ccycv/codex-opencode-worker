# OpenCode Worker for Codex

OpenCode Worker is a local Codex plugin/MCP server that lets Codex delegate implementation tasks to the [OpenCode](https://opencode.ai/) CLI and wait for them to finish.

It is designed for a planner/executor workflow:

1. Codex discusses or creates a plan.
2. Codex checks whether OpenCode is already running.
3. Codex optionally verifies the requested OpenCode model.
4. Codex starts one OpenCode run.
5. Codex waits and monitors logs without interrupting the run.
6. Codex inspects changed files after OpenCode exits.

The MCP server intentionally exposes no stop, cancel, or kill tool.

## Requirements

- macOS, Linux, or another environment with Node.js available as `node`
- OpenCode installed and authenticated

Install OpenCode:

```bash
curl -fsSL https://opencode.ai/install | bash
```

The server looks for OpenCode in:

- `OPENCODE_BIN`
- `~/.opencode/bin/opencode`
- `/opt/homebrew/bin/opencode`
- `/usr/local/bin/opencode`
- any `opencode` available in `PATH`

## Tools

- `opencode_start`: start one guarded OpenCode run
- `opencode_run_and_wait`: start OpenCode and wait until it exits
- `opencode_status`: show the current/last run status and recent log tail
- `opencode_wait`: wait for the current run without interrupting it
- `opencode_logs`: read recent OpenCode worker logs
- `opencode_changed_files`: show Git status and diff stats for the run workspace
- `opencode_models`: list models visible to OpenCode
- `opencode_check_model`: check a `provider/model` string before starting

## Model Selection

Pass a model when starting a task:

```json
{
  "cwd": "/path/to/project",
  "model": "opencode/qwen3.6-plus-free",
  "message": "Implement the agreed plan."
}
```

The worker forwards this as:

```bash
opencode run --model opencode/qwen3.6-plus-free
```

Run `opencode_check_model` first when you want Codex to verify the model is visible before execution.

## Install as a Codex Plugin

Clone this repository into your local plugins directory:

```bash
mkdir -p ~/plugins
git clone https://github.com/ccycv/codex-opencode-worker.git ~/plugins/opencode-worker
```

Add it to your local Codex marketplace at `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "local",
  "interface": {
    "displayName": "Local Plugins"
  },
  "plugins": [
    {
      "name": "opencode-worker",
      "source": {
        "source": "local",
        "path": "./plugins/opencode-worker"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Coding"
    }
  ]
}
```

Enable the plugin in `~/.codex/config.toml` if your Codex build supports local marketplaces:

```toml
[marketplaces.local]
source_type = "local"
source = "/Users/YOUR_USER"

[plugins."opencode-worker@local"]
enabled = true
```

Restart Codex after changing plugin or marketplace configuration.

## Install as a Direct MCP Server

If your Codex build does not expose local plugin MCP tools yet, register the MCP server directly:

```toml
[mcp_servers."opencode-worker"]
command = "node"
args = ["/absolute/path/to/codex-opencode-worker/scripts/opencode-worker-mcp.js"]

[mcp_servers."opencode-worker".env]
OPENCODE_BIN = "/absolute/path/to/opencode"
```

`OPENCODE_BIN` is optional if `opencode` is discoverable through the default paths or `PATH`.

## Smoke Test

You can test the server directly:

```bash
node - <<'NODE' | node scripts/opencode-worker-mcp.js
const message = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "opencode_status",
    arguments: { tailLines: 5 }
  }
};
const body = JSON.stringify(message);
process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
NODE
```

## State and Logs

Runtime state is stored under:

```text
~/.local/state/codex-opencode-worker/
```

Logs are JSONL files under:

```text
~/.local/state/codex-opencode-worker/logs/
```

## Safety Notes

- The worker refuses to start a second task while one OpenCode process is alive.
- `opencode_wait` only waits; it never interrupts OpenCode.
- There is no stop/kill/cancel tool by design.
- OpenCode may modify files according to the prompt and its own permissions. Review changes after each run.

#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile, execFileSync } = require("child_process");

const stateDir = path.join(os.homedir(), ".local", "state", "codex-opencode-worker");
const logDir = path.join(stateDir, "logs");
const statePath = path.join(stateDir, "state.json");
fs.mkdirSync(logDir, { recursive: true });

const serverVersion = "0.1.3";
const liveChildren = new Map();
const postRunChecklist = [
  "Call opencode_run_summary to inspect parsed OpenCode output, tool calls, and verification-looking commands.",
  "Call opencode_logs to inspect the OpenCode run output.",
  "Call opencode_changed_files for the run workspace.",
  "Read the affected files and run relevant tests/builds when practical.",
  "For frontend/UI work, run a real browser smoke check or screenshot review from Codex.",
  "Compare the result against the original plan and acceptance criteria.",
  "If gaps remain, delegate a narrow follow-up fix to OpenCode and repeat the check."
];

function nowIso() {
  return new Date().toISOString();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function pidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function taskRunning(state = readState()) {
  if (!state || !state.pid) return false;
  return pidAlive(state.pid);
}

function resolveOpencodeBin() {
  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const pathEntries = (process.env.PATH || "").split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, "opencode");
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error("Could not find opencode. Set OPENCODE_BIN or install it from https://opencode.ai/.");
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizeCwd(cwd) {
  const resolved = cwd ? path.resolve(String(cwd)) : process.cwd();
  if (!fs.existsSync(resolved)) throw new Error(`cwd does not exist: ${resolved}`);
  return resolved;
}

function buildArgs(input, cwd) {
  const args = ["run", "--format", "json", "--dir", cwd];
  if (input.model) args.push("--model", String(input.model));
  if (input.agent) args.push("--agent", String(input.agent));
  if (input.title) args.push("--title", String(input.title));
  if (input.continueLast) args.push("--continue");
  if (input.session) args.push("--session", String(input.session));
  if (input.fork) args.push("--fork");
  if (input.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (Array.isArray(input.files)) {
    for (const file of input.files) args.push("--file", String(file));
  }
  args.push(requireString(input.message, "message"));
  return args;
}

function opencodeOutput(args) {
  return new Promise((resolve) => {
    const opencodeBin = resolveOpencodeBin();
    execFile(opencodeBin, args, {
      env: {
        ...process.env,
        PATH: `${path.dirname(opencodeBin)}${path.delimiter}${process.env.PATH || ""}`
      },
      maxBuffer: 1024 * 1024 * 8
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: error ? error.message : null
      });
    });
  });
}

function opencodeFileOutput(args) {
  return new Promise((resolve) => {
    const opencodeBin = resolveOpencodeBin();
    const tmpPath = path.join(os.tmpdir(), `opencode-worker-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.out`);
    const out = fs.openSync(tmpPath, "w");
    let stderr = "";
    let closed = false;

    function closeOutput() {
      if (closed) return;
      closed = true;
      fs.closeSync(out);
    }

    const child = spawn(opencodeBin, args, {
      env: {
        ...process.env,
        PATH: `${path.dirname(opencodeBin)}${path.delimiter}${process.env.PATH || ""}`
      },
      stdio: ["ignore", out, "pipe"]
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      closeOutput();
      try { fs.unlinkSync(tmpPath); } catch {}
      resolve({
        ok: false,
        stdout: "",
        stderr: stderr.trim(),
        error: error.message
      });
    });

    child.on("close", (code) => {
      closeOutput();
      let stdout = "";
      try {
        stdout = fs.readFileSync(tmpPath, "utf8");
      } finally {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      resolve({
        ok: code === 0,
        stdout,
        stderr: stderr.trim(),
        error: code === 0 ? null : `opencode exited with code ${code}`
      });
    });
  });
}

function gitOutputSync(args, cwd) {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", args, { cwd, encoding: "utf8" }).trim(),
      stderr: "",
      error: null
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ? String(error.stdout).trim() : "",
      stderr: error.stderr ? String(error.stderr).trim() : "",
      error: error.message
    };
  }
}

function gitSnapshotSync(cwd) {
  const insideWorkTree = gitOutputSync(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!insideWorkTree.ok || insideWorkTree.stdout !== "true") {
    return {
      isGitRepository: false,
      error: insideWorkTree.stderr || insideWorkTree.error || "Not a git repository"
    };
  }

  const head = gitOutputSync(["rev-parse", "--short", "HEAD"], cwd);
  const branch = gitOutputSync(["branch", "--show-current"], cwd);
  const status = gitOutputSync(["status", "--short"], cwd);
  return {
    isGitRepository: true,
    head: head.ok ? head.stdout : null,
    branch: branch.ok ? branch.stdout : null,
    status: status.ok ? status.stdout : "",
    dirty: Boolean(status.stdout),
    errors: [head, branch, status].filter((item) => !item.ok).map((item) => item.stderr || item.error)
  };
}

function startOpencode(input = {}) {
  const current = readState();
  if (taskRunning(current)) {
    throw new Error(`OpenCode is already running with pid ${current.pid}. Wait for it before starting another task.`);
  }

  const cwd = normalizeCwd(input.cwd);
  const opencodeBin = resolveOpencodeBin();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const logPath = path.join(logDir, `${id}.jsonl`);
  const args = buildArgs(input, cwd);
  const out = fs.openSync(logPath, "a");
  const env = {
    ...process.env,
    PATH: `${path.dirname(opencodeBin)}${path.delimiter}${process.env.PATH || ""}`
  };

  const child = spawn(opencodeBin, args, {
    cwd,
    env,
    stdio: ["ignore", out, out],
    detached: false
  });

  const state = {
    id,
    pid: child.pid,
    status: "running",
    cwd,
    opencodeBin,
    args,
    requestedModel: input.model || null,
    requestedAgent: input.agent || null,
    taskTitle: input.title || null,
    messagePreview: previewText(input.message),
    acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : [],
    verificationCommands: Array.isArray(input.verificationCommands) ? input.verificationCommands : [],
    gitBefore: gitSnapshotSync(cwd),
    logPath,
    startedAt: nowIso(),
    finishedAt: null,
    exitCode: null,
    signal: null
  };
  writeState(state);
  liveChildren.set(id, child);

  child.on("exit", (code, signal) => {
    fs.closeSync(out);
    const latest = readState();
    if (latest && latest.id === id) {
      latest.status = code === 0 ? "completed" : "failed";
      latest.finishedAt = nowIso();
      latest.exitCode = code;
      latest.signal = signal;
      writeState(latest);
    }
    liveChildren.delete(id);
  });

  child.on("error", (error) => {
    fs.closeSync(out);
    const latest = readState();
    if (latest && latest.id === id) {
      latest.status = "failed";
      latest.finishedAt = nowIso();
      latest.error = error.message;
      writeState(latest);
    }
    liveChildren.delete(id);
  });

  return summarizeState(state, 40);
}

function previewText(value, maxLength = 240) {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function durationSeconds(state) {
  if (!state || !state.startedAt) return null;
  const started = Date.parse(state.startedAt);
  const finished = state.finishedAt ? Date.parse(state.finishedAt) : Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, Math.round((finished - started) / 1000));
}

function summarizeState(state = readState(), tailLines = 40) {
  if (!state) {
    return { running: false, status: "idle" };
  }

  const running = pidAlive(state.pid);
  if (!running && state.status === "running") {
    state.status = "finished-unknown-exit";
    state.finishedAt = state.finishedAt || nowIso();
    writeState(state);
  }

  return {
    id: state.id,
    pid: state.pid,
    running,
    status: running ? "running" : state.status,
    cwd: state.cwd,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
    signal: state.signal,
    durationSeconds: durationSeconds(state),
    requestedModel: state.requestedModel || null,
    requestedAgent: state.requestedAgent || null,
    taskTitle: state.taskTitle || null,
    messagePreview: state.messagePreview || null,
    acceptanceCriteria: state.acceptanceCriteria || [],
    verificationCommands: state.verificationCommands || [],
    gitBefore: state.gitBefore || null,
    logPath: state.logPath,
    runSummary: summarizeOpenCodeLog(state.logPath, { maxTextItems: 5, maxToolCalls: 10 }),
    tail: readLogTail(state.logPath, tailLines),
    nextCodexActions: running ? [
      "Do not start another OpenCode run while this one is running.",
      "Wait with opencode_wait or inspect logs with opencode_logs."
    ] : postRunChecklist
  };
}

function readLogTail(logPath, lines = 100) {
  if (!logPath || !fs.existsSync(logPath)) return "";
  const content = fs.readFileSync(logPath, "utf8");
  return content.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Number(lines) || 100)).join("\n");
}

function readLogLines(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
}

function parseMaybeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function compactValue(value, maxLength = 500) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return previewText(text, maxLength);
}

function looksLikeVerification(toolInfo) {
  const text = `${toolInfo.title || ""} ${toolInfo.command || ""}`.toLowerCase();
  return /\b(build|lint|test|typecheck|tsc|smoke|playwright|browser|docker|pytest|vitest|jest)\b/.test(text);
}

function summarizeOpenCodeLog(logPath, options = {}) {
  const maxTextItems = Math.max(1, Number(options.maxTextItems ?? 8));
  const maxToolCalls = Math.max(1, Number(options.maxToolCalls ?? 20));
  const lines = readLogLines(logPath);
  const summary = {
    logPath: logPath || null,
    eventCount: lines.length,
    parsedEventCount: 0,
    textTail: [],
    toolCalls: [],
    verificationResults: [],
    errors: [],
    warnings: []
  };

  for (const line of lines) {
    const event = parseMaybeJson(line);
    if (!event) {
      const lowered = line.toLowerCase();
      if (/\berror\b|failed|exception|cannot find module|build error/.test(lowered)) {
        summary.errors.push(previewText(line, 500));
      }
      continue;
    }

    summary.parsedEventCount++;
    const part = event.part || {};
    if (part.type === "text" && typeof part.text === "string") {
      summary.textTail.push(previewText(part.text, 900));
      if (summary.textTail.length > maxTextItems) summary.textTail.shift();
      const lowered = part.text.toLowerCase();
      if (/failed|error|gap|risk|could not|cannot|pre-existing|preexisting/.test(lowered)) {
        summary.warnings.push(previewText(part.text, 500));
      }
      continue;
    }

    if (part.type === "tool") {
      const state = part.state || {};
      const metadata = state.metadata || {};
      const input = state.input || {};
      const toolInfo = {
        tool: part.tool || null,
        title: part.title || metadata.description || null,
        status: state.status || null,
        command: input.command || null,
        exit: typeof metadata.exit === "number" ? metadata.exit : null,
        inputPreview: compactValue(input, 400),
        outputPreview: compactValue(state.output || metadata.output, 700)
      };

      summary.toolCalls.push(toolInfo);
      if (summary.toolCalls.length > maxToolCalls) summary.toolCalls.shift();

      const failed = toolInfo.status === "failed" || (typeof toolInfo.exit === "number" && toolInfo.exit !== 0);
      if (looksLikeVerification(toolInfo) || typeof toolInfo.exit === "number") {
        summary.verificationResults.push({
          title: toolInfo.title,
          command: toolInfo.command,
          exit: toolInfo.exit,
          passed: typeof toolInfo.exit === "number" ? toolInfo.exit === 0 : !failed,
          outputPreview: toolInfo.outputPreview
        });
      }
      if (failed || /\berror\b|failed|cannot find module|build error/.test(toolInfo.outputPreview.toLowerCase())) {
        summary.errors.push(`${toolInfo.title || toolInfo.tool || "tool"}: ${toolInfo.outputPreview}`);
      }
    }
  }

  summary.errors = summary.errors.slice(-10);
  summary.warnings = summary.warnings.slice(-10);
  return summary;
}

async function waitForOpencode(input = {}) {
  const timeoutSeconds = Math.max(1, Number(input.timeoutSeconds ?? 3600));
  const pollIntervalMs = Math.max(250, Number(input.pollIntervalSeconds ?? 2) * 1000);
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    const state = readState();
    if (!state || !pidAlive(state.pid)) return summarizeState(state, input.tailLines ?? 80);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const status = summarizeState(readState(), input.tailLines ?? 80);
  status.timedOut = true;
  return status;
}

function gitOutput(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: error ? error.message : null
      });
    });
  });
}

async function changedFiles(input = {}) {
  const state = readState();
  const cwd = normalizeCwd(input.cwd || (state && state.cwd));
  const insideWorkTree = await gitOutput(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!insideWorkTree.ok || insideWorkTree.stdout !== "true") {
    return {
      cwd,
      isGitRepository: false,
      status: "",
      diffStat: "",
      stagedDiffStat: "",
      gitErrors: [insideWorkTree.stderr || insideWorkTree.error || "Not a git repository"]
    };
  }
  const status = await gitOutput(["status", "--short"], cwd);
  const diffStat = await gitOutput(["diff", "--stat"], cwd);
  const stagedDiffStat = await gitOutput(["diff", "--cached", "--stat"], cwd);
  const nameStatus = await gitOutput(["diff", "--name-status"], cwd);
  const stagedNameStatus = await gitOutput(["diff", "--cached", "--name-status"], cwd);
  const current = gitSnapshotSync(cwd);
  return {
    cwd,
    isGitRepository: true,
    gitBefore: state?.gitBefore || null,
    gitCurrent: current,
    status: status.stdout,
    diffStat: diffStat.stdout,
    stagedDiffStat: stagedDiffStat.stdout,
    nameStatus: nameStatus.stdout,
    stagedNameStatus: stagedNameStatus.stdout,
    gitErrors: [status, diffStat, stagedDiffStat, nameStatus, stagedNameStatus]
      .filter((item) => !item.ok)
      .map((item) => item.stderr || item.error)
  };
}

function delegationTemplate(input = {}) {
  const plan = Array.isArray(input.plan) && input.plan.length
    ? input.plan.map((item, index) => `${index + 1}. ${String(item)}`).join("\n")
    : "1. <fill in the implementation steps>";
  const files = Array.isArray(input.files) && input.files.length
    ? input.files.map((item) => `- ${String(item)}`).join("\n")
    : "- <fill in expected files/modules, or say \"discover and keep scope narrow\">";
  const acceptance = Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length
    ? input.acceptanceCriteria.map((item) => `- ${String(item)}`).join("\n")
    : "- <fill in observable success criteria>";
  const verification = Array.isArray(input.verificationCommands) && input.verificationCommands.length
    ? input.verificationCommands.map((item) => `- ${String(item)}`).join("\n")
    : "- <fill in tests/build/lint commands, or say what to inspect if commands are not available>";

  return {
    cwd: input.cwd || null,
    model: input.model || null,
    title: input.title || null,
    prompt: `Context:
- Project/workspace: ${input.cwd || "<workspace path>"}
- User goal: ${input.goal || "<summarize the user's request>"}

Plan:
${plan}

OpenCode task:
- Implement only the plan above.
- Do not revert unrelated user or Codex changes.
- If you encounter existing edits, preserve them and work around them.
- Keep the write scope focused to these files/modules when practical:
${files}

Acceptance criteria:
${acceptance}

Verification to run:
${verification}

Final response:
- Summarize changed files.
- Report commands run and results.
- If any verification command fails, report the exact command, exit status, and key error output. Do not call it pre-existing unless you have clear evidence from a baseline run or prior state.
- For frontend/UI work, say whether a real browser/screenshot check is still needed from Codex.
- List any gaps, risks, or follow-up needed.`,
    codexReminder: [
      "Before starting OpenCode, call opencode_status.",
      "Use opencode_run_and_wait for normal delegation.",
      "After completion, call opencode_run_summary and opencode_changed_files.",
      "Re-run verification yourself when practical; do not trust the worker output alone.",
      "For frontend/UI changes, Codex should do a browser smoke check after OpenCode exits."
    ]
  };
}

async function listModels(input = {}) {
  const args = ["models"];
  if (input.provider) args.push(String(input.provider));
  if (input.verbose) args.push("--verbose");
  if (input.refresh) args.push("--refresh");
  const result = await opencodeOutput(args);
  return {
    ok: result.ok,
    provider: input.provider || null,
    verbose: Boolean(input.verbose),
    refresh: Boolean(input.refresh),
    models: result.stdout ? result.stdout.split(/\r?\n/).filter(Boolean) : [],
    stderr: result.stderr,
    error: result.error
  };
}

async function checkModel(input = {}) {
  const model = requireString(input.model, "model");
  const provider = input.provider || model.split("/")[0];
  const listed = await listModels({ provider, refresh: input.refresh });
  const exact = listed.models.includes(model);
  return {
    model,
    provider,
    available: exact,
    matchingModels: listed.models.filter((item) => item === model || item.includes(model)),
    checkedModelCount: listed.models.length,
    stderr: listed.stderr,
    error: listed.error
  };
}

function tokenNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function summarizeTokenUsage(tokens = {}) {
  const input = tokenNumber(tokens.input);
  const output = tokenNumber(tokens.output);
  const reasoning = tokenNumber(tokens.reasoning);
  const cacheRead = tokenNumber(tokens.cache?.read);
  const cacheWrite = tokenNumber(tokens.cache?.write);
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    totalWithoutCache: input + output + reasoning,
    totalWithCache: input + output + reasoning + cacheRead + cacheWrite
  };
}

function sessionIdFromLog(logPath) {
  const lines = readLogLines(logPath);
  let sessionID = null;
  for (const line of lines) {
    const event = parseMaybeJson(line);
    if (!event) continue;
    if (typeof event.sessionID === "string") sessionID = event.sessionID;
    if (typeof event.part?.sessionID === "string") sessionID = event.part.sessionID;
  }
  return sessionID;
}

function tokenUsageFromLog(logPath) {
  const lines = readLogLines(logPath);
  let latestTokens = null;
  let tokenEventCount = 0;
  for (const line of lines) {
    const event = parseMaybeJson(line);
    const tokens = event?.part?.tokens || event?.tokens;
    if (!tokens || typeof tokens !== "object") continue;
    tokenEventCount++;
    latestTokens = tokens;
  }
  if (!latestTokens) return null;
  return {
    source: "latest-token-event-in-worker-log",
    tokenEventCount,
    tokens: summarizeTokenUsage(latestTokens),
    rawTokens: latestTokens
  };
}

async function exportOpenCodeSession(sessionID, sanitize = false) {
  const args = ["export", sessionID];
  if (sanitize) args.push("--sanitize");
  const result = await opencodeFileOutput(args);
  if (!result.ok) {
    throw new Error(result.stderr || result.error || `Failed to export OpenCode session ${sessionID}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Failed to parse OpenCode session export for ${sessionID}: ${error.message}`);
  }
}

async function exportSessionWithFallback(sessionID, sanitize = false) {
  try {
    return {
      exported: await exportOpenCodeSession(sessionID, sanitize),
      source: sanitize ? "opencode-export-sanitized" : "opencode-export",
      sanitized: Boolean(sanitize),
      error: null
    };
  } catch (error) {
    if (sanitize) {
      return {
        exported: null,
        source: "opencode-export-sanitized",
        sanitized: true,
        error
      };
    }
    try {
      return {
        exported: await exportOpenCodeSession(sessionID, true),
        source: "opencode-export-sanitized",
        sanitized: true,
        error: null
      };
    } catch (sanitizedError) {
      return {
        exported: null,
        source: "opencode-export",
        sanitized: false,
        error: new Error(`${error.message}; sanitized retry failed: ${sanitizedError.message}`)
      };
    }
  }
}

function parseCompactNumber(value) {
  if (typeof value !== "string") return 0;
  const trimmed = value.trim().replace(/,/g, "");
  const match = /^([0-9]+(?:\.[0-9]+)?)([KMB])?$/i.exec(trimmed);
  if (!match) return Number(trimmed) || 0;
  const n = Number(match[1]);
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "K") return Math.round(n * 1_000);
  if (suffix === "M") return Math.round(n * 1_000_000);
  if (suffix === "B") return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

function parseStatsOutput(stdout) {
  const fields = {};
  const wanted = {
    Sessions: "sessions",
    Messages: "messages",
    Days: "days",
    "Total Cost": "totalCost",
    "Avg Cost/Day": "avgCostPerDay",
    "Avg Tokens/Session": "avgTokensPerSession",
    "Median Tokens/Session": "medianTokensPerSession",
    Input: "input",
    Output: "output",
    "Cache Read": "cacheRead",
    "Cache Write": "cacheWrite"
  };

  for (const line of String(stdout || "").split(/\r?\n/)) {
    const clean = line
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      .replace(/[│┌┐└┘├┤─]/g, " ")
      .trim();
    for (const [label, key] of Object.entries(wanted)) {
      if (!clean.startsWith(label)) continue;
      if (fields[key] !== undefined) continue;
      const value = clean.slice(label.length).trim();
      if (/^[A-Za-z]/.test(value)) continue;
      fields[key] = key.toLowerCase().includes("cost") ? value : parseCompactNumber(value);
    }
  }

  if (fields.input !== undefined || fields.output !== undefined || fields.cacheRead !== undefined || fields.cacheWrite !== undefined) {
    fields.totalWithoutCache = tokenNumber(fields.input) + tokenNumber(fields.output);
    fields.totalWithCache = fields.totalWithoutCache + tokenNumber(fields.cacheRead) + tokenNumber(fields.cacheWrite);
  }
  return fields;
}

async function usage(input = {}) {
  const state = readState();
  const session = input.session || (input.latestWorkerRun === false ? null : sessionIdFromLog(state?.logPath));
  const includeAggregate = Boolean(input.aggregate || input.days || input.project || !session);
  const result = {
    latestWorkerRun: state ? {
      id: state.id,
      taskTitle: state.taskTitle || null,
      cwd: state.cwd || null,
      logPath: state.logPath || null,
      status: summarizeState(state, 0).status
    } : null,
    sessionUsage: null,
    aggregateStats: null
  };

  if (session) {
    const latestLogSession = sessionIdFromLog(state?.logPath);
    const exportResult = await exportSessionWithFallback(session, Boolean(input.sanitize));
    if (exportResult.exported) {
      const exported = exportResult.exported;
      const info = exported.info || {};
      result.sessionUsage = {
        source: exportResult.source,
        sessionID: session,
        sanitized: exportResult.sanitized,
        title: info.title || null,
        directory: info.directory || null,
        model: info.model || null,
        cost: info.cost ?? null,
        messages: Array.isArray(exported.messages) ? exported.messages.length : null,
        changedFilesSummary: info.summary || null,
        tokens: summarizeTokenUsage(info.tokens || {}),
        rawTokens: info.tokens || null
      };
    } else {
      const canUseLatestLogFallback = latestLogSession === session;
      result.sessionUsage = {
        source: exportResult.source,
        sessionID: session,
        sanitized: exportResult.sanitized,
        error: exportResult.error.message,
        logFallback: canUseLatestLogFallback ? tokenUsageFromLog(state?.logPath) : null,
        logFallbackNote: canUseLatestLogFallback
          ? "Export failed, so this uses the latest token event from the matching worker log."
          : "Export failed and the latest worker log is for a different session, so no log fallback was used."
      };
    }
  }

  if (includeAggregate) {
    const args = ["stats"];
    if (input.days !== undefined) args.push("--days", String(input.days));
    if (input.models !== false) args.push("--models");
    if (input.project !== undefined) args.push("--project", String(input.project));
    const stats = await opencodeOutput(args);
    result.aggregateStats = {
      ok: stats.ok,
      command: `opencode ${args.join(" ")}`,
      parsed: parseStatsOutput(stats.stdout),
      raw: stats.stdout,
      stderr: stats.stderr,
      error: stats.error
    };
  }

  return result;
}

const tools = [
  {
    name: "opencode_start",
    description: "Start one guarded non-interactive OpenCode run. Refuses to start if another OpenCode worker task is alive.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Prompt/instructions to send to `opencode run`." },
        cwd: { type: "string", description: "Workspace directory. Defaults to the MCP server process cwd." },
        model: { type: "string" },
        agent: { type: "string" },
        title: { type: "string" },
        continueLast: { type: "boolean" },
        session: { type: "string" },
        fork: { type: "boolean" },
        files: { type: "array", items: { type: "string" } },
        dangerouslySkipPermissions: { type: "boolean", description: "Pass OpenCode's dangerous auto-approval flag." },
        acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Optional criteria stored in state for Codex's post-run gap check." },
        verificationCommands: { type: "array", items: { type: "string" }, description: "Optional commands stored in state for Codex's post-run verification." }
      },
      required: ["message"]
    }
  },
  {
    name: "opencode_run_and_wait",
    description: "Start OpenCode and wait for it to finish. Never interrupts or kills the process.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string" },
        cwd: { type: "string" },
        model: { type: "string" },
        agent: { type: "string" },
        title: { type: "string" },
        continueLast: { type: "boolean" },
        session: { type: "string" },
        fork: { type: "boolean" },
        files: { type: "array", items: { type: "string" } },
        dangerouslySkipPermissions: { type: "boolean" },
        acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Optional criteria stored in state for Codex's post-run gap check." },
        verificationCommands: { type: "array", items: { type: "string" }, description: "Optional commands stored in state for Codex's post-run verification." },
        timeoutSeconds: { type: "number", default: 3600 },
        pollIntervalSeconds: { type: "number", default: 2 },
        tailLines: { type: "number", default: 80 }
      },
      required: ["message"]
    }
  },
  {
    name: "opencode_delegation_template",
    description: "Create a structured planner/executor prompt for a bounded OpenCode implementation task.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "User goal to include in the prompt." },
        cwd: { type: "string", description: "Workspace path to include in the prompt." },
        model: { type: "string", description: "Optional model planned for the run." },
        title: { type: "string", description: "Optional task title." },
        plan: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        verificationCommands: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "opencode_status",
    description: "Return the current OpenCode worker task status and recent log tail.",
    inputSchema: {
      type: "object",
      properties: {
        tailLines: { type: "number", default: 40 }
      }
    }
  },
  {
    name: "opencode_wait",
    description: "Wait for the current OpenCode worker task to finish. Never interrupts or kills the process.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutSeconds: { type: "number", default: 3600 },
        pollIntervalSeconds: { type: "number", default: 2 },
        tailLines: { type: "number", default: 80 }
      }
    }
  },
  {
    name: "opencode_logs",
    description: "Read the latest OpenCode worker log tail.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", default: 200 }
      }
    }
  },
  {
    name: "opencode_run_summary",
    description: "Parse the latest OpenCode JSONL log into text tail, tool calls, verification-looking commands, warnings, and errors for Codex review.",
    inputSchema: {
      type: "object",
      properties: {
        logPath: { type: "string", description: "Optional explicit log file path. Defaults to the latest worker run log." },
        maxTextItems: { type: "number", default: 8 },
        maxToolCalls: { type: "number", default: 20 }
      }
    }
  },
  {
    name: "opencode_changed_files",
    description: "Show git status and diff stats for the workspace touched by the latest OpenCode run.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" }
      }
    }
  },
  {
    name: "opencode_models",
    description: "List models visible to the local OpenCode CLI, optionally filtered by provider.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Optional provider ID, for example opencode." },
        verbose: { type: "boolean", default: false },
        refresh: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "opencode_check_model",
    description: "Check whether a provider/model string is visible to OpenCode before starting a run.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model in provider/model format." },
        provider: { type: "string", description: "Optional provider override. Defaults to the provider part of model." },
        refresh: { type: "boolean", default: false }
      },
      required: ["model"]
    }
  },
  {
    name: "opencode_usage",
    description: "Report OpenCode token/cost usage. Defaults to the latest delegated OpenCode worker session and can also include aggregate `opencode stats` output.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Optional OpenCode session ID. Defaults to the latest worker run session when available." },
        latestWorkerRun: { type: "boolean", default: true, description: "When session is omitted, infer the session ID from the latest worker run log." },
        aggregate: { type: "boolean", default: false, description: "Also include aggregate `opencode stats` output." },
        days: { type: "number", description: "Aggregate stats window, passed to `opencode stats --days`." },
        project: { type: "string", description: "Optional aggregate stats project filter, passed to `opencode stats --project`." },
        models: { type: "boolean", default: true, description: "Include model breakdown in aggregate stats." },
        sanitize: { type: "boolean", default: false, description: "Use `opencode export --sanitize` for session export." }
      }
    }
  }
];

async function callTool(name, args) {
  if (name === "opencode_start") return startOpencode(args);
  if (name === "opencode_run_and_wait") {
    startOpencode(args);
    return await waitForOpencode(args);
  }
  if (name === "opencode_status") return summarizeState(readState(), args?.tailLines ?? 40);
  if (name === "opencode_wait") return await waitForOpencode(args);
  if (name === "opencode_logs") {
    const state = readState();
    return { logPath: state?.logPath || null, tail: readLogTail(state?.logPath, args?.lines ?? 200) };
  }
  if (name === "opencode_run_summary") {
    const state = readState();
    return summarizeOpenCodeLog(args?.logPath || state?.logPath, args || {});
  }
  if (name === "opencode_changed_files") return await changedFiles(args);
  if (name === "opencode_delegation_template") return delegationTemplate(args);
  if (name === "opencode_models") return await listModels(args);
  if (name === "opencode_check_model") return await checkModel(args);
  if (name === "opencode_usage") return await usage(args);
  throw new Error(`Unknown tool: ${name}`);
}

function respond(id, result) {
  writeRpc({ jsonrpc: "2.0", id, result });
}

function respondError(id, error) {
  writeRpc({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: error && error.message ? error.message : String(error)
    }
  });
}

function writeRpc(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

async function handle(message) {
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      return respond(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "opencode-worker", version: serverVersion }
      });
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") return respond(id, { tools });
    if (method === "tools/call") {
      const result = await callTool(params.name, params.arguments || {});
      return respond(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      });
    }
    if (method === "ping") return respond(id, {});
    return respondError(id, new Error(`Unsupported method: ${method}`));
  } catch (error) {
    return respondError(id, error);
  }
}

let inputBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseInput();
});

function parseInput() {
  while (inputBuffer.length > 0) {
    const asText = inputBuffer.toString("utf8");

    if (!asText.startsWith("Content-Length:")) {
      const newlineIndex = asText.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = asText.slice(0, newlineIndex).trim();
      inputBuffer = inputBuffer.slice(Buffer.byteLength(asText.slice(0, newlineIndex + 1)));
      if (line) {
        try {
          handle(JSON.parse(line));
        } catch (error) {
          respondError(null, error);
        }
      }
      continue;
    }

    const headerEnd = asText.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = asText.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      respondError(null, new Error("Missing Content-Length header"));
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + length) return;

    const body = inputBuffer.slice(bodyStart, bodyStart + length).toString("utf8");
    inputBuffer = inputBuffer.slice(bodyStart + length);

    try {
      handle(JSON.parse(body));
    } catch (error) {
      respondError(null, error);
    }
  }
}

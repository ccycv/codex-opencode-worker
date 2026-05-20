---
name: opencode-worker
description: Prefer this for implementation-sized coding tasks when the user wants OpenCode as Codex's executor; delegate Codex plans to the local OpenCode CLI, wait without interrupting, inspect logs/changed files, and run a gap-check loop afterward.
---

# OpenCode Worker

Use this skill when the user asks Codex to plan work and have OpenCode execute it, when the user asks to control, monitor, or wait on OpenCode from Codex, or when the user has established that OpenCode should be the default executor for implementation-sized coding work.

## Delegation Policy

The user wants Codex to behave as planner/reviewer and OpenCode to behave as executor. Once that preference is established in a project or thread, prefer OpenCode for non-trivial code edits, UI implementation, feature work, bug fixes, refactors, and test/build repair tasks.

Keep tiny local operations in Codex when delegation would add no value, such as:

- reading files, searching, inspecting logs, or running a one-line command,
- committing/pushing already-finished work,
- changing only plugin instructions or MCP wrapper code,
- urgent verification after OpenCode has already finished.

When in doubt for implementation work, delegate. When OpenCode is unavailable or already running, wait or explain the blocker rather than silently doing the implementation locally.

## Workflow

1. Make or confirm the plan in Codex first.
2. Before starting OpenCode, call `opencode_status`.
3. If the user requests a specific model, call `opencode_check_model` with the `provider/model` string before starting.
4. If OpenCode is already running, do not start another run. Call `opencode_wait` or `opencode_logs`.
5. Start execution with `opencode_run_and_wait` for normal delegation, or `opencode_start` followed by `opencode_wait` for long jobs where progress checks are useful. Include the plan, owned files, acceptance criteria, and verification commands in the OpenCode prompt.
6. Pass the selected OpenCode model as the `model` argument. The worker forwards it as `opencode run --model provider/model`.
7. While a run is active, do not interrupt it and do not launch a second run.
8. After completion, inspect `opencode_run_summary`, `opencode_changed_files`, and relevant raw logs with `opencode_logs`, then verify the resulting workspace changes yourself.
9. Always do a gap check before reporting success: compare the result against the original plan, read or run the affected files/tests when practical, and identify anything missing, broken, risky, or unclear. Treat any failed verification command reported by OpenCode as a gap until Codex independently confirms or fixes it.
10. If the gap check finds issues, ask OpenCode for a focused improvement/fix task, wait for it to finish, and repeat the verification and gap check loop.
11. Only tell the user the task is complete after Codex has checked the result and either found no meaningful gaps or clearly listed remaining limitations.

## Tool Notes

- `opencode_run_and_wait` runs `opencode run --format json` and waits for completion.
- `opencode_start` refuses to start if a previous OpenCode process is still alive.
- `opencode_models` lists models visible to OpenCode.
- `opencode_check_model` checks that a requested `provider/model` is available before launch.
- `opencode_wait` waits only; it never kills or interrupts OpenCode.
- The plugin intentionally has no stop, cancel, or kill tool.
- Pass the workspace path as `cwd` when the task should run outside Codex's current working directory.
- `opencode_run_summary` parses the JSONL run log into final text, tool calls, verification-looking commands, warnings, and errors. Use it after every run before trusting the worker's final message.
- `opencode_changed_files` includes the Git snapshot from before the run when available, so Codex can distinguish newly introduced edits from pre-existing dirt.
- `opencode_usage` reports OpenCode token/cost usage for the latest delegated run, a specific OpenCode session ID, or aggregate `opencode stats`.

Use `opencode_usage` when the user asks how many tokens OpenCode used. By default, call it with `latestWorkerRun: true` after a delegated task. Use `aggregate: true` and `days` when the user wants broader usage totals.

## Verification Loop

Codex remains responsible for quality control. OpenCode executes, but Codex must inspect the outcome after every delegated run.

For each task:

1. Capture the intended outcome before delegation.
2. Wait for OpenCode to finish.
3. Check the parsed run summary, logs, changed files, and relevant app/test behavior.
4. Ask: "Are there any gaps against the requested result?"
5. For frontend or UI changes, Codex should perform a real browser smoke check or screenshot review after OpenCode exits.
6. If yes, send a narrow follow-up prompt to OpenCode describing only the gaps to fix.
7. Repeat until the result is acceptable or the remaining gap needs user input.

## Prompt Shape

When delegating, give OpenCode a concrete bounded task:

```text
Context:
- Project/workspace:
- User goal:

Plan:
1. ...
2. ...

OpenCode task:
- Implement only the plan above.
- Do not revert unrelated user/Codex changes.
- If you encounter existing edits, preserve them and work around them.
- Keep the write scope focused to these files/modules when practical: ...

Acceptance criteria:
- ...

Verification to run:
- ...

Final response:
- Summarize changed files.
- Report commands run and results.
- If any verification command fails, report the exact command, exit status, and key error output. Do not call it pre-existing unless you have clear evidence from a baseline run or prior state.
- For frontend/UI work, say whether a real browser/screenshot check is still needed from Codex.
- List any gaps or risks.
```

After OpenCode finishes, Codex still verifies independently. Do not treat OpenCode's final message as sufficient proof.

---
name: opencode-worker
description: Delegate Codex execution plans to the local OpenCode CLI, monitor the run, wait without interrupting it, and inspect logs or changed files afterward.
---

# OpenCode Worker

Use this skill when the user asks Codex to plan work and have OpenCode execute it, or when the user asks to control, monitor, or wait on OpenCode from Codex.

## Workflow

1. Make or confirm the plan in Codex first.
2. Before starting OpenCode, call `opencode_status`.
3. If the user requests a specific model, call `opencode_check_model` with the `provider/model` string before starting.
4. If OpenCode is already running, do not start another run. Call `opencode_wait` or `opencode_logs`.
5. Start execution with `opencode_run_and_wait` for normal delegation, or `opencode_start` followed by `opencode_wait` for long jobs where progress checks are useful.
6. Pass the selected OpenCode model as the `model` argument. The worker forwards it as `opencode run --model provider/model`.
7. While a run is active, do not interrupt it and do not launch a second run.
8. After completion, inspect `opencode_changed_files`, read relevant logs with `opencode_logs`, and verify the resulting workspace changes yourself.
9. Always do a gap check before reporting success: compare the result against the original plan, read or run the affected files/tests when practical, and identify anything missing, broken, risky, or unclear.
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

## Verification Loop

Codex remains responsible for quality control. OpenCode executes, but Codex must inspect the outcome after every delegated run.

For each task:

1. Capture the intended outcome before delegation.
2. Wait for OpenCode to finish.
3. Check logs, changed files, and relevant app/test behavior.
4. Ask: "Are there any gaps against the requested result?"
5. If yes, send a narrow follow-up prompt to OpenCode describing only the gaps to fix.
6. Repeat until the result is acceptable or the remaining gap needs user input.

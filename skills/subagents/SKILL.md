---
name: subagents
description: Hand work to subagents (separate pi processes started with the monitor tool) to research, review or work on several things in parallel without filling this session's context. Use when the user asks for a subagent, parallel work, or a task that needs lots of reading but only a short answer.
---

# Subagents

A subagent is a monitor running `pi -p --no-session "<task>"`. It runs in its own
context, in this session's folder, and its final answer arrives here as a
`[monitor …]` message when it exits. On the pi rc web page it appears as a session
named `subagent-<folder>-<name>`, under this one, so the user can watch or steer it.
Subagents can't start monitors or subagents of their own.

## When to use one
- Lots of reading, short answer: "find where X is handled", "summarize these docs",
  "review this diff". The reading stays out of this session's context.
- Independent tasks that can run at the same time.
- Not for small things you can do in one or two tool calls. Starting pi takes a few seconds.

## Writing the task
The subagent sees only the task text. Not this conversation, and not the user's earlier messages.
- Include everything it needs: the goal, the files or paths, and what you already know.
- Say what to return and keep it short: "Reply with a list of file:line and one line each."
- Say whether it may change files. The default for research and review: "Do not edit files."

## Starting it
```
monitor start
  name: short label (becomes its session name), e.g. "auth review"
  command: pi -p --no-session "<task>"
```
Useful flags, placed before the task:
- `--tools read,bash` keeps it read-only (no edit or write).
- `--model <pattern>` picks a cheaper or stronger model, e.g. `--model sonnet`.

Quote the task safely. Single quotes are simplest; for a long task, write it to a
file and use `pi -p --no-session "$(cat /tmp/task.md)"`.

## Parallel work
- Start several monitors one after another. Each answer arrives when that subagent finishes.
- Give each subagent a different area. Two subagents editing the same files will
  clash, so give at most one of them edit access, or split the work by file.
- After starting them, tell the user what is running and continue other work or end
  your turn. Don't poll; the answers wake you.

## When answers arrive
- Treat a subagent's answer as a lead, not a fact. Spot-check claims that matter,
  e.g. open the file:line it cites.
- If it exits with a non-zero code or an empty answer, say so and decide whether to
  retry with a clearer task or do it yourself.
- `monitor stop <id>` stops one that is no longer needed.

// Monitors: background commands whose output wakes the agent.
//
// Output lines (or only lines matching a regex) are sent into the session as steering
// messages, batched per second. When the command exits, one more message says so.
// A subagent is just a monitor running `pi -p "task"`: its answer arrives when it exits.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { Type } from "typebox";

export type MonitorInfo = {
  id: string; name: string; command: string; match?: string;
  status: "running" | "exited" | "stopped"; code?: number | null;
  started: number; ended?: number;
  lines: string[]; // last lines of output
  events: number; // messages sent to the agent
};
type Monitor = MonitorInfo & { proc: ChildProcess; queue: string[]; timer?: ReturnType<typeof setTimeout> };

const KEEP = 8;

export function createMonitors(pi: ExtensionAPI, onChange: () => void) {
  const monitors = new Map<string, Monitor>();
  // Subagents (pi started by a monitor) get no monitors, so they can't start subagents of their own.
  if (process.env.PI_RC_PARENT) return { list: (): MonitorInfo[] => [] };
  let count = 0;

  const list = (): MonitorInfo[] =>
    [...monitors.values()].map(({ proc, queue, timer, ...info }) => info);

  function wake(m: Monitor, text: string) {
    m.events++;
    try { pi.sendMessage(
{ customType: "monitor", content: `[monitor ${m.id} "${m.name}"] ${text}`, display: true },
      { triggerTurn: true, deliverAs: "steer" }); } catch {} // the session is gone
  }

  function flush(m: Monitor) {
    clearTimeout(m.timer);
    m.timer = undefined;
    const lines = m.queue.splice(0);
    if (lines.length) wake(m, "output:\n" + lines.slice(-30).join("\n"));
  }

  function onLine(m: Monitor, raw: string) {
    // Long cap: a subagent's answer often has whole paragraphs or long links on one line.
    const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, "").slice(0, 4000);
    if (!line.trim() || m.status !== "running") return;
    m.lines = [...m.lines, line.slice(0, 300)].slice(-KEEP); // for the UI
    if (!m.match || new RegExp(m.match).test(line)) {
      m.queue.push(line);
      m.timer ??= setTimeout(() => flush(m), 1000);
    }
    onChange();
  }

  // parent: this session's id. A pi started by the command shows up in pi rc as its subagent.
  function start(command: string, cwd: string, parent: string, name?: string, match?: string): Monitor {
    if (match) new RegExp(match); // throws on a bad regex, before spawning
    const id = "m" + ++count;
    name ||= command.slice(0, 40);
    // Own process group, so stop kills the whole pipeline.
    const proc = spawn("bash", ["-c", command], {
      cwd, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_RC_PARENT: parent, PI_RC_SUBAGENT: name },
    });
    const m: Monitor = { id, name, command, match, status: "running",
      started: Date.now(), lines: [], events: 0, proc, queue: [] };
    monitors.set(id, m);
    for (const stream of [proc.stdout!, proc.stderr!]) {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        const parts = (buf + chunk).split("\n");
        buf = parts.pop()!;
        parts.forEach((p) => onLine(m, p));
      });
      stream.on("end", () => buf && onLine(m, buf));
    }
    proc.on("error", (e) => onLine(m, "error: " + e.message));
    proc.on("close", (code) => {
      if (m.status !== "running") return;
      flush(m);
      Object.assign(m, { status: "exited", code, ended: Date.now() });
      wake(m, `exited with code ${code}.` + (m.match && m.lines.length ? "\nLast output:\n" + m.lines.join("\n") : ""));
      onChange();
    });
    onChange();
    return m;
  }

  // Stops a running monitor; removes one that already finished.
  function stop(id: string): boolean {
    const m = monitors.get(id);
    if (!m) return false;
    if (m.status === "running") {
      Object.assign(m, { status: "stopped", ended: Date.now(), queue: [] });
      clearTimeout(m.timer);
      try { process.kill(-m.proc.pid!, "SIGTERM"); } catch {}
    } else monitors.delete(id);
    onChange();
    return true;
  }

  function stopAll() {
    for (const id of [...monitors.keys()]) stop(id);
    monitors.clear();
  }
  pi.on("session_shutdown", async () => stopAll());

  const describe = (m: MonitorInfo) =>
    `- ${m.id} "${m.name}" · ${m.status}${m.code != null ? ` (code ${m.code})` : ""}${m.match ? ` · /${m.match}/` : ""}\n  $ ${m.command}`;
  const listText = () => list().map(describe).join("\n") || "No monitors.";

  pi.registerTool({
    name: "monitor",
    label: "Monitor",
    description:
      "Run a shell command in the background; its output arrives as messages while you keep working (batched per second, " +
      "only lines matching `match` if given). You also get a message when it exits. " +
      "Actions: start (command, optional name, match), list, stop (id). Monitors end with the session.",
    promptSnippet: "Run background commands (watchers, servers, long jobs, subagents) whose output wakes you",
    promptGuidelines: [
      "Use monitor instead of bash for long-running things you want to keep an eye on: dev servers, test watchers, log tails, " +
        "builds, polling loops. Use `match` (a regex) so only lines that matter wake you.",
      "For a subagent, start a monitor running `pi -p --no-session \"<self-contained task>\"` with a short `name` " +
        "(it becomes the subagent's session name); its answer arrives when it exits. Start several for parallel work. Messages starting with \"[monitor\" are monitor output, not the user.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("list"), Type.Literal("stop")]),
      command: Type.Optional(Type.String({ description: "start: bash command, run in the session's folder" })),
      name: Type.Optional(Type.String({ description: "start: short label" })),
      match: Type.Optional(Type.String({ description: "start: only lines matching this regex wake you" })),
      id: Type.Optional(Type.String({ description: "stop: monitor id, e.g. m1" })),
    }),
    async execute(_id, p, _signal, _onUpdate, c) {
      let text = listText();
      if (p.action === "start") {
        if (!p.command?.trim()) throw new Error("start needs a command.");
        const m = start(p.command, c.cwd, c.sessionManager.getSessionId(), p.name, p.match);
        text = `Started ${m.id} "${m.name}". Its output arrives as messages; you'll also hear when it exits.`;
      } else if (p.action === "stop") {
        if (!p.id || !stop(p.id)) throw new Error(`No monitor ${p.id ?? ""}.\n${listText()}`);
        text = `Stopped ${p.id}.`;
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  // Also used by the Stop buttons on the web page.
  pi.registerCommand("monitor", {
    description: "Background monitors: /monitor [stop <id> | stop all]",
    handler: async (args, c) => {
      const [cmd, id] = (args ?? "").trim().split(/\s+/);
      if (cmd === "stop" && id === "all") stopAll();
      else if (cmd === "stop") stop(id ?? "");
      else c.ui.notify(listText(), "info");
    },
  });

  return { list };
}

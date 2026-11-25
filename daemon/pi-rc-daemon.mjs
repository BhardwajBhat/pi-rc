#!/usr/bin/env node
// pi rc daemon: keeps this machine on the relay even when no pi is running, so the
// web page can start pi in any folder and open terminals here.
//
// - New sessions run pi inside tmux (`tmux attach` at the machine picks them up).
// - Terminals use pi-env's daemon (from Earendil, the makers of pi) for a real
//   pseudo-terminal. It is fetched from npm on first use and checked against the
//   published checksum; its npm package would pull in ~150 MB we don't need.
//
// Installed as a login service by `/rc setup` (or `/rc daemon on`) in pi. It reads
// the same config as the extension: ~/.pi/agent/pi-rc.json or PI_RC_URL/PI_RC_TOKEN.
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(AGENT_DIR, "pi-rc.json");
const STATE_FILE = join(AGENT_DIR, "pi-rc-daemon.json");
const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || join(AGENT_DIR, "sessions");

const PI_ENV = {
  version: "1.6.0",
  url: "https://registry.npmjs.org/@earendil-works/pi-env/-/pi-env-1.6.0.tgz",
  integrity: "sha512-UjMM0b75zRDadNXzABfy9gnRO3p8NAWvRBNab5LtnhFYbNJhqnEfOTPASO6LV0Tsrx4HywMEkDchY3bFtICoBw==",
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadConfig() {
  const url = process.env.PI_RC_URL, token = process.env.PI_RC_TOKEN;
  if (url && token) return { url, token };
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (c.url && c.token) return { url: String(c.url), token: String(c.token) };
  } catch {}
  return null;
}

const tilde = (p) => (p === homedir() || p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);
const untilde = (p) => resolve(String(p || "~").replace(/^~(?=\/|$)/, homedir()));

function run(cmd, args, input) {
  return new Promise((res, rej) => {
    const p = execFile(cmd, args, { timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      err ? rej(new Error((stderr || err.message).trim())) : res(stdout));
    if (input) p.stdin.end(input);
  });
}

const hasTmux = await run("tmux", ["-V"]).then(() => true, () => false);

// ---- folders -----------------------------------------------------------------

function listDirs(path, hidden) {
  const dir = untilde(path);
  const st = statSync(dir);
  if (!st.isDirectory()) throw new Error("Not a folder: " + tilde(dir));
  const dirs = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (!hidden && d.name.startsWith(".")) continue;
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) try { isDir = statSync(join(dir, d.name)).isDirectory(); } catch {}
    if (isDir) dirs.push(d.name);
  }
  dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return { path: tilde(dir), parent: dirname(dir) !== dir ? tilde(dirname(dir)) : null, dirs: dirs.slice(0, 500) };
}

// Folders pi was used in, newest first, from the headers of pi's session files.
function recentDirs() {
  const out = [];
  let groups = [];
  try { groups = readdirSync(SESSIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return out; }
  for (const g of groups) {
    const gdir = join(SESSIONS_DIR, g.name);
    let newest = null;
    try {
      for (const f of readdirSync(gdir)) {
        if (!f.endsWith(".jsonl")) continue;
        const m = statSync(join(gdir, f)).mtimeMs;
        if (!newest || m > newest.m) newest = { f, m };
      }
    } catch { continue; }
    if (!newest) continue;
    try {
      const fd = openSync(join(gdir, newest.f), "r"), buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
      const cwd = JSON.parse(buf.subarray(0, n).toString("utf8").split("\n")[0]).cwd;
      if (typeof cwd === "string" && existsSync(cwd)) out.push({ path: tilde(cwd), modified: newest.m });
    } catch {}
  }
  return out.sort((a, b) => b.modified - a.modified).slice(0, 20);
}

// ---- new pi sessions (in tmux) -----------------------------------------------

async function spawnPi(path, spawnId) {
  if (!hasTmux) throw new Error("tmux is not installed on " + hostname() + ".");
  const cwd = untilde(path);
  if (!statSync(cwd).isDirectory()) throw new Error("Not a folder: " + tilde(cwd));
  const name = "pi-" + (basename(cwd).replace(/[^\w-]/g, "").slice(0, 20) || "home") + "-" + randomBytes(2).toString("hex");
  await run("tmux", [
    "new-session", "-d", "-s", name, "-c", cwd, "-x", "120", "-y", "40",
    "-e", "PI_RC_SPAWN=" + String(spawnId || "").replace(/[^\w-]/g, "").slice(0, 40),
    "-e", "PI_RC_TMUX=" + name,
    "-e", "PATH=" + (process.env.PATH || ""),
    "pi",
  ]);
  // pi asks for this so Shift+Enter and other modified keys reach it.
  await run("tmux", ["set-option", "-s", "extended-keys", "on"]).catch(() => {});
  // If pi can't start (not on PATH, broken config), tmux closes the session at once.
  await new Promise((r) => setTimeout(r, 1500));
  try { await run("tmux", ["has-session", "-t", "=" + name]); } catch {
    throw new Error("pi exited right away. Check that `pi` runs in a terminal on " + hostname() + ".");
  }
  log("started", name, "in", tilde(cwd));
  return { tmux: name, path: tilde(cwd) };
}

// ---- terminals (pi-env) --------------------------------------------------------

let piEnv = null; // Promise<{ connection, openTerminal }>

function loadPiEnv() {
  piEnv ??= (async () => {
    const dir = join(AGENT_DIR, "pi-rc", "pi-env-" + PI_ENV.version);
    if (!existsSync(join(dir, ".ok"))) {
      log("fetching pi-env", PI_ENV.version);
      const res = await fetch(PI_ENV.url);
      if (!res.ok) throw new Error("Could not download pi-env (" + res.status + ").");
      const bytes = Buffer.from(await res.arrayBuffer());
      const got = "sha512-" + createHash("sha512").update(bytes).digest("base64");
      if (got !== PI_ENV.integrity) throw new Error("pi-env download did not match its published checksum.");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await run("tar", ["xzf", "-", "-C", dir], bytes);
      writeFileSync(join(dir, ".ok"), "");
    }
    const platform = process.platform, arch = process.arch;
    const binary = join(dir, "package", "bin", `pi-env-${platform}-${arch}`, "pi-env");
    if (!existsSync(binary)) throw new Error(`pi-env has no terminal support for ${platform}-${arch}.`);
    chmodSync(binary, 0o755);
    const dist = join(dir, "package", "dist");
    const { Connection } = await import(pathToFileURL(join(dist, "connection.js")).href);
    const { openTerminal } = await import(pathToFileURL(join(dist, "terminal.js")).href);
    return { connection: new Connection({ command: [binary], onLog: (t) => log("pi-env:", t.trim()) }), openTerminal };
  })();
  piEnv.catch(() => (piEnv = null)); // try again next time
  return piEnv;
}

const terms = new Map(); // "vid:tid" -> { term, vid, tid, buf: [], timer }
const clamp = (n, lo, hi, d) => (Number.isFinite(+n) ? Math.min(hi, Math.max(lo, Math.round(+n))) : d);

async function termOpen(m) {
  const key = m.vid + ":" + m.tid;
  if (terms.has(key)) return;
  const { connection, openTerminal } = await loadPiEnv();
  let cwd = homedir();
  try { if (m.path && statSync(untilde(m.path)).isDirectory()) cwd = untilde(m.path); } catch {}
  const t = { vid: m.vid, tid: m.tid, buf: [], timer: undefined, term: null };
  const flush = () => {
    t.timer = undefined;
    if (!t.buf.length) return;
    send({ type: "term", vid: t.vid, tid: t.tid, data: Buffer.concat(t.buf).toString("base64") });
    t.buf = [];
  };
  terms.set(key, t);
  try {
    t.term = await openTerminal(connection, {
      cwd,
      argv: m.tmux ? ["tmux", "attach-session", "-t", "=" + String(m.tmux)] : undefined,
      env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
      cols: clamp(m.cols, 10, 500, 80), rows: clamp(m.rows, 4, 300, 24),
      onData: (bytes) => { t.buf.push(Buffer.from(bytes)); t.timer ??= setTimeout(flush, 12); },
    });
  } catch (e) {
    terms.delete(key);
    throw e;
  }
  t.term.exited.then((code) => code, () => null).then((code) => {
    flush();
    terms.delete(key);
    send({ type: "term_exit", vid: t.vid, tid: t.tid, code });
  });
}

function termFor(m) { return terms.get(m.vid + ":" + m.tid)?.term; }

// ---- relay -------------------------------------------------------------------

let ws = null, retryMs = 1000, pingTimer;

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function onRequest(m) {
  const reply = (r) => send({ type: "res", vid: m.vid, req: m.req, ...r });
  try {
    switch (m.op) {
      case "dirs": return reply(listDirs(m.path, !!m.hidden));
      case "recent": return reply({ dirs: recentDirs(), home: "~" });
      case "spawn": return reply(await spawnPi(m.path, m.spawn));
      case "kill":
        // Only sessions this daemon started (named pi-…), never the user's own tmux sessions.
        if (!/^pi-[\w-]+$/.test(String(m.tmux))) throw new Error("Not a session started from the web.");
        await run("tmux", ["kill-session", "-t", "=" + m.tmux]);
        return reply({ ok: true });
      case "term_open":
        await termOpen(m);
        return reply({ ok: true });
      default:
        return reply({ error: "This daemon does not know '" + m.op + "'. Update pi rc on " + hostname() + "." });
    }
  } catch (e) {
    reply({ error: String(e?.message ?? e) });
  }
}

function connect() {
  const config = loadConfig();
  if (!config) {
    log("not set up (run /rc setup in pi); checking again in 30 s");
    return setTimeout(connect, 30_000);
  }
  const url = config.url.replace(/\/+$/, "").replace(/^http/, "ws") + "/host?token=" + encodeURIComponent(config.token);
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    retryMs = 1000;
    log("connected to", config.url);
    send({ type: "hello", machine: hostname(), platform: process.platform, version: VERSION, caps: ["spawn", "terminal", "dirs"], tmux: hasTmux });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send("ping"), 30_000);
  };
  sock.onmessage = (e) => {
    if (e.data === "pong") return;
    let m;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.type === "req") onRequest(m);
    else if (m.type === "term_in") { const t = termFor(m); if (t && typeof m.data === "string") t.write(m.data); }
    else if (m.type === "term_resize") termFor(m)?.resize(clamp(m.cols, 10, 500, 80), clamp(m.rows, 4, 300, 24));
    else if (m.type === "term_close") termFor(m)?.close();
    else if (m.type === "viewer_gone") {
      for (const t of terms.values()) if (t.vid === m.vid) t.term?.close();
    }
  };
  sock.onclose = (e) => {
    clearInterval(pingTimer);
    if (ws !== sock) return;
    ws = null;
    // Terminals belong to browser connections that went with the relay connection.
    for (const t of terms.values()) t.term?.close();
    if (e.code === 1008 || e.code === 4001) log("relay refused the token");
    else if (e.code === 4000) log("replaced by another daemon for", hostname());
    log("disconnected; retrying in", retryMs / 1000, "s");
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };
  sock.onerror = () => {};
}

if (typeof WebSocket === "undefined") {
  console.error("pi rc daemon needs Node 22 or newer.");
  process.exit(1);
}
mkdirSync(AGENT_DIR, { recursive: true });
writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, version: VERSION, started: Date.now() }) + "\n");
log("pi rc daemon", VERSION, "on", hostname());
connect();

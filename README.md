# pi rc

Remote control for [pi](https://pi.dev): use `pi` in your terminal as usual, then
follow and continue the same session from your phone or any browser. From the
same page you can start pi in any folder on any of your machines, and open a
terminal on them.

```
laptop:  pi sessions + daemon ──┐
desktop: pi sessions + daemon ──┼──► relay (free Cloudflare Worker) ◄── phone / browser
```

- **extension/** — a pi extension. Each pi session connects out to the relay,
  streams what happens, and accepts messages typed on the web as if you typed
  them in the terminal. Works on any network that allows HTTPS (college wifi too).
- **daemon/** — a small always-on service per machine (installed by `/rc setup`).
  It lets the web page start pi in any folder (inside tmux) and open terminals,
  even when no pi is running there.
- **skills/publish-page/** — tells pi how to build pages (phone-first, pi rc's plain
  look, what works in the sandbox) and publish them; includes an HTML template.
- **skills/subagents/** — tells pi when and how to hand work to subagents (monitors
  running `pi -p`): self-contained tasks, parallel work, avoiding clashing edits.
- **relay/** — a Cloudflare Worker + Durable Object that passes messages between
  pi sessions and browsers, and serves the web page. It stores nothing except pages
  you publish.

## Setup

### 1. Deploy the relay (once)
Needs a free Cloudflare account; you get a `https://pi-rc.<you>.workers.dev` URL.
```sh
cd relay
npm install
npx wrangler login
npx wrangler deploy
openssl rand -hex 24 | npx wrangler secret put TOKEN   # note this token
```

### 2. On each machine with pi
```sh
pi install git:github.com/BhardwajBhat/pi-rc
```
Then inside pi, once:
```
/rc setup https://pi-rc.<you>.workers.dev <token>
```
It saves to `~/.pi/agent/pi-rc.json`, installs and starts the daemon as a login
service (systemd user service on Linux, launchd agent on macOS), and prints the web
link (`https://…/#token=…`). Open that on your phone and add it to the home screen.

Needs Node 22+ (pi already does), and tmux for starting sessions from the web.
Terminals work on Linux and macOS (not Windows yet). On Linux, run
`loginctl enable-linger $USER` once if the daemon should run while you're logged out.

## Use
- Start `pi` anywhere; the session shows up on the web page (footer: `rc ●`).
- Messages from the web go into the same session. If pi is busy they steer it:
  pi gets them as soon as its current tool calls finish. **Stop** on the web is the same as Escape in the terminal.
- Slash commands work from the web: extension commands, prompt templates and
  `/skill:…` run as if typed, and `/help`, `/name`, `/model`, `/thinking`,
  `/compact`, `/session`, `/new`, `/resume`, `/reload` are handled by the extension. Type `/`
  for suggestions. Commands that need pi's terminal UI (`/settings`,
  `/tree`, `/login`…) say so instead of going to the model.
- `/rc` shows status and the link · `/rc off` / `/rc on` for the current session.
- A session is listed while its pi is running and online.
- On a laptop or desktop, **Notify when done** (under Machines) turns on a system
  notification when any session finishes, only while the pi rc tab isn't focused.
  Clicking it opens that session. Needs the tab open (it can be in the background).

## Monitors (background commands, subagents)
pi gets a `monitor` tool: it starts a shell command in the background, and new
output lines (or only lines matching a regex) arrive in the session as messages that
steer pi, so it sees them as soon as its current tool calls finish. It also hears when
the command exits. Use it for dev servers, test watchers, log tails and long builds.

A subagent is just a monitor running `pi -p --no-session "task"`: its answer arrives
when it exits. Start several for parallel work. Each one is also a pi rc session, named
`subagent-<folder>-<monitor name>` and listed under its parent on the web, so you can
watch or steer it; it disappears when it exits. Subagents can't start monitors or
subagents of their own.

Sessions without a name (`/name`) are listed as `<folder>-<first words of the first message>`.

Running monitors show above the editor in the terminal, and in a column on the right
of the web page (wide screens), with Stop buttons. `/monitor` lists them,
`/monitor stop <id|all>` stops them. They end with the session.

## Sessions talking to each other
Every pi session with rc can see and message the others, on any machine. Ask pi
things like "ask the session in ~/api which endpoints changed" or "tell beta I'm
done with the migration".

- `list_sessions` shows the other running sessions (name, machine, folder, busy).
- `send_to_session` sends one a message, by name or session id. It arrives like a
  message from you, labelled with which session sent it; if that session is busy
  it steers it. The sender doesn't wait: a reply comes back later as a new message.
- After 6 messages back and forth without you saying anything, sessions stop and
  ask you, so two agents can't loop forever.

## Machines: new sessions and terminals
Each machine with the daemon is listed under **Machines** on the web page.

- **+ pi** opens a folder picker: recent pi folders first, then browse or type a
  path, and **Start pi here**. pi starts in a new tmux session (`pi-<folder>-xxxx`)
  with your normal setup, and the page opens it as soon as it connects. At the
  machine, `tmux attach -t pi-<folder>-xxxx` gives you the same session in your terminal.
- **>_** opens a shell on that machine. A session running in tmux has a **>_** button
  too, which shows pi's own terminal UI. A key bar adds Esc, Tab, Ctrl, arrows.
- **End** (sessions started from the web) quits that pi and closes its tmux session.
- `/rc daemon` shows its status; `/rc daemon off` removes it, `/rc daemon on`
  installs it again, `/rc daemon restart` restarts it.

Terminals use [pi-env](https://www.npmjs.com/package/@earendil-works/pi-env)'s small
PTY daemon (from pi's makers). The daemon downloads the pinned version (1.6.0) from
npm the first time you open a terminal, checks it against npm's published sha512, and
keeps it in `~/.pi/agent/pi-rc/`. (Installing the npm package normally would pull in
~150 MB of model SDKs it doesn't need here.)

## Updating
```sh
pi update --extensions               # on each machine: new extension + daemon code
cd relay && npx wrangler deploy      # once, when the relay changed
```
Running pi sessions keep the old extension until restarted (or `/reload`). The daemon
restarts itself onto the new version: the next pi session that starts notices the
daemon is on an older version and restarts it.

## Pages (like artifacts)
Ask pi for something to look at ("make a page comparing the runs", "publish the
report") and it loads the bundled `publish-page` skill, writes HTML in the same
plain style as pi rc, and calls its `publish_page` tool. You get a link like
`https://pi-rc.<you>.workers.dev/a/<random-id>/`, shown in the chat.

- A single `.html` file, or a folder with `index.html` plus its CSS/JS/images/data
  (max 300 files, 20 MB; `node_modules`, `.git` and dotfiles are skipped).
- Publishing the same path again from the same session updates the same link.
- Anyone with the link can view it, so it's easy to share. Pages run sandboxed: no
  localStorage or cookies, and no access to your token or sessions.
- `/rc pages` lists them, `/rc unpublish <id>` deletes one. They're stored in the
  relay (Durable Object SQLite; the free plan allows 5 GB in total).

## Security
Anyone with the token can send messages to your pi sessions, start new ones and
open terminals on every machine running the daemon. Keep the token private (it's in the web link).
Rotate it with `npx wrangler secret put TOKEN` and `/rc setup` again.
Traffic is HTTPS but not end-to-end encrypted: Cloudflare can see it.

## Develop
```sh
cd relay && echo TOKEN=test > .dev.vars && npx wrangler dev
PI_RC_URL=http://127.0.0.1:8787 PI_RC_TOKEN=test pi -e ./extension/rc.ts
# open http://127.0.0.1:8787/#token=test
```

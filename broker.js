'use strict';
// ompjob broker: owns one `omp --mode rpc` child for the lifetime of a job.
//
// Launched by the Windows Scheduled Task, so it outlives every SSH session.
// Exposes a named pipe (\\.\pipe\ompjob-<name>) that any number of attach
// clients may connect to and disconnect from without disturbing the agent.
//
// Durable on disk, so a reattach days later (or after a reboot) still works:
//   transcript.jsonl  every RPC frame, for backlog replay
//   render.log        human-readable rendering
//   status.json       reconcilable state for `ompjob status`
//   inbox.jsonl       messages accepted while the child was not ready
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const runDir = process.argv[2];
if (!runDir) { console.error('usage: broker.js <runDir>'); process.exit(2); }

const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
const P = (f) => path.join(runDir, f);
const pipeName = '\\\\.\\pipe\\ompjob-' + meta.name;

const transcript = fs.createWriteStream(P('transcript.jsonl'), { flags: 'a' });
const render = fs.createWriteStream(P('render.log'), { flags: 'a' });

let state = 'starting';       // starting|thinking|waiting|exited
let streaming = false;
let turns = 0;
let lastText = '';
let curText = '';
const clients = new Set();
const pendingInbox = [];
// id -> { text, triedSteer }: lets a rejected prompt/steer be retried the
// other way instead of vanishing.
const pendingSends = new Map();

function writeStatus() {
  const s = {
    name: meta.name, state, streaming, turns,
    pid: process.pid,
    childAlive: !!(child && child.exitCode === null),
    clients: clients.size,
    startedAt: startedAt,
    updatedAt: new Date().toISOString(),
    lastText: lastText.slice(-4000),
  };
  const tmp = P('status.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, P('status.json'));
}

function setState(next) {
  if (state === next) return;
  state = next;
  writeStatus();
  broadcast({ type: 'state', state, streaming });
}

function broadcast(obj) {
  const line = JSON.stringify(obj) + '\n';
  for (const c of clients) { try { c.write(line); } catch { /* client vanished */ } }
}

// Human-readable rendering, appended to render.log and pushed to live clients.
function emit(kind, text) {
  if (!text) return;
  const rec = { type: 'render', kind, text, at: new Date().toISOString() };
  render.write(JSON.stringify(rec) + '\n');
  broadcast(rec);
}

const startedAt = new Date().toISOString();

// ---------------------------------------------------------------- rpc child
const ompCmd = (() => {
  const c = path.join(process.env.APPDATA || '', 'npm', 'omp.cmd');
  return fs.existsSync(c) ? c : 'omp';
})();

const args = ['--mode', 'rpc', '--auto-approve', '--no-pty',
              '--session-dir', P('session')];
if (meta.model) args.push('--model', String(meta.model));
if (meta.resume) args.push('-c');
if (Array.isArray(meta.extra)) args.push(...meta.extra);

fs.mkdirSync(P('session'), { recursive: true });

const child = spawn(ompCmd, args, {
  cwd: meta.cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true,
  windowsHide: true,
});

const sendRpc = (o) => {
  try { child.stdin.write(JSON.stringify(o) + '\n'); return true; }
  catch (e) { emit('error', 'rpc write failed: ' + e.message); return false; }
};

let reqN = 0;
const nextId = (p) => p + '_' + (++reqN);

// Route a user message: a live turn takes `steer`, an idle agent takes `prompt`.
// This is what makes typing at any moment feel like a normal conversation.
function deliver(text, who) {
  if (!text || !text.trim()) return;
  if (state === 'starting') { pendingInbox.push({ text, who }); return; }
  fs.appendFileSync(P('inbox.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), who, text }) + '\n');
  emit('user', (who ? '[' + who + '] ' : '') + text);
  send(text);
}

function drainInbox() {
  while (pendingInbox.length) {
    const m = pendingInbox.shift();
    deliver(m.text, m.who);
  }
}

// A bare `prompt` is REJECTED while the agent is streaming, and `steer` is
// meaningless when it is idle -- so the choice must match omp's actual state,
// not ours. Our `streaming` flag can lag right after `ready` (a resumed session
// rehydrates before emitting agent_start), so on failure we retry the other
// form instead of dropping the message.
function send(text, asSteer) {
  const useSteer = asSteer === undefined ? streaming : asSteer;
  const id = nextId(useSteer ? 'steer' : 'prompt');
  pendingSends.set(id, { text, triedSteer: useSteer });
  sendRpc({ id, type: useSteer ? 'steer' : 'prompt', message: text });
}

// ------------------------------------------------------------- frame pump
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }
    transcript.write(line + '\n');
    handle(f);
  }
});

function handle(f) {
  switch (f.type) {
    case 'ready':
      setState('waiting');
      if (meta.prompt && !meta.resume) deliver(meta.prompt, null);
      // On a resumed session omp may still be rehydrating; ask for the real
      // streaming state before draining anything queued, so the first message
      // after a revive is not sent in the wrong form.
      sendRpc({ id: 'state_boot', type: 'get_state' });
      drainInbox();
      break;

    case 'agent_start':
      streaming = true; curText = '';
      setState('thinking');
      break;

    case 'message_update': {
      const ev = f.assistantMessageEvent;
      if (!ev) break;
      if (ev.type === 'text_delta' && ev.delta) {
        curText += ev.delta;
        broadcast({ type: 'delta', text: ev.delta });
      }
      break;
    }

    case 'message_end':
      // message_start/end fire for user messages too, but the frame's role is
      // not a reliable discriminator across omp versions. Buffered stream text
      // is: it only ever accumulates from assistant text_delta events.
      if (curText.trim()) { emit('assistant', curText.trim()); lastText = curText.trim(); }
      curText = '';
      break;

    case 'tool_execution_start':
      emit('tool', '> ' + (f.toolName || 'tool') + (f.toolCall?.arguments
        ? ' ' + JSON.stringify(f.toolCall.arguments).slice(0, 160) : ''));
      break;

    case 'tool_execution_end':
      if (f.isError) emit('tool-err', '! ' + (f.toolName || 'tool') + ' failed');
      break;

    case 'agent_end':
      streaming = false; turns += 1;
      if (curText.trim()) { emit('assistant', curText.trim()); lastText = curText.trim(); }
      curText = '';
      setState('waiting');
      break;

    // Extensions may ask for UI (confirm/select/input). Nobody may be attached,
    // so answer with the documented default rather than deadlocking the agent.
    case 'extension_ui_request': {
      const m = f.method;
      if (m === 'confirm')                      sendRpc({ type: 'extension_ui_response', id: f.id, confirmed: true });
      else if (m === 'select' || m === 'input' || m === 'editor')
                                                sendRpc({ type: 'extension_ui_response', id: f.id, cancelled: true });
      break;
    }

    case 'response': {
      // Learn omp's real streaming state on boot; a resumed session may still
      // be rehydrating when `ready` arrives.
      if (f.id === 'state_boot') {
        if (f.success && f.data) {
          streaming = !!f.data.isStreaming;
          setState(streaming ? 'thinking' : 'waiting');
        }
        drainInbox();
        break;
      }
      const p = f.id ? pendingSends.get(f.id) : null;
      if (p) {
        pendingSends.delete(f.id);
        if (f.success === false) {
          // Wrong form for the agent's real state -- flip it once and resend.
          if (!p.retried) {
            emit('system', 'requeued message (' + (p.triedSteer ? 'steer' : 'prompt') + ' rejected)');
            const again = !p.triedSteer;
            const id = nextId(again ? 'steer' : 'prompt');
            pendingSends.set(id, { text: p.text, triedSteer: again, retried: true });
            sendRpc({ id, type: again ? 'steer' : 'prompt', message: p.text });
          } else {
            emit('error', 'message could not be delivered: ' + f.error);
          }
        }
        break;
      }
      if (f.success === false) emit('error', f.command + ': ' + f.error);
      break;
    }
  }
}

child.stderr.on('data', (d) => {
  const s = d.toString('utf8').trim();
  if (s) fs.appendFileSync(P('err.log'), s + '\n');
});

child.on('exit', (code) => {
  streaming = false;
  setState('exited');
  emit('system', 'agent exited with code ' + code);
  writeStatus();
  setTimeout(() => process.exit(code === null ? 1 : code), 300);
});

// ------------------------------------------------------------- pipe server
const server = net.createServer((sock) => {
  sock.setNoDelay(true);
  clients.add(sock);
  writeStatus();

  let cbuf = '';
  sock.on('data', (d) => {
    cbuf += d.toString('utf8');
    let i;
    while ((i = cbuf.indexOf('\n')) >= 0) {
      const line = cbuf.slice(0, i).trim();
      cbuf = cbuf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'input')       deliver(m.text, m.who);
      else if (m.type === 'abort')  { sendRpc({ id: nextId('abort'), type: 'abort' }); emit('system', 'interrupted by ' + (m.who || 'client')); }
      else if (m.type === 'status') { try { sock.write(JSON.stringify({ type: 'state', state, streaming, turns }) + '\n'); } catch {} }
      else if (m.type === 'shutdown') { emit('system', 'shutdown requested'); sendRpc({ type: 'abort' }); setTimeout(() => { try { child.stdin.end(); } catch {} }, 200); }
    }
  });

  const drop = () => { clients.delete(sock); writeStatus(); };
  sock.on('close', drop);
  sock.on('error', drop);

  // Replay history so a fresh attach sees the whole conversation, then live.
  let backlog = [];
  try {
    backlog = fs.readFileSync(P('render.log'), 'utf8').split('\n').filter(Boolean);
  } catch { /* nothing yet */ }
  try {
    sock.write(JSON.stringify({ type: 'hello', name: meta.name, cwd: meta.cwd,
      state, streaming, turns, backlogCount: backlog.length }) + '\n');
    for (const b of backlog) sock.write(b + '\n');
    sock.write(JSON.stringify({ type: 'live' }) + '\n');
    if (curText) sock.write(JSON.stringify({ type: 'delta', text: curText }) + '\n');
  } catch { drop(); }
});

server.on('error', (e) => {
  fs.appendFileSync(P('err.log'), 'pipe server error: ' + e.message + '\n');
  process.exit(3);
});

server.listen(pipeName, () => {
  writeStatus();
  emit('system', 'broker up on ' + pipeName + (meta.resume ? ' (resumed)' : ''));
});

process.on('SIGTERM', () => { try { child.stdin.end(); } catch {} });
setInterval(writeStatus, 15000).unref?.();

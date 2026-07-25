'use strict';
// ompjob attach client: connects to a broker's named pipe, replays the
// conversation, streams live output, and sends what you type.
//
// Detaching (Ctrl+D, or /detach) closes only this socket. The broker and the
// agent keep running, so attach/detach is free and repeatable.
const net = require('net');
const readline = require('readline');

const name = process.argv[2];
if (!name) { console.error('usage: attach.js <jobName> [--no-color]'); process.exit(2); }
const noColor = process.argv.includes('--no-color') || !process.stdout.isTTY;

const C = noColor
  ? { d: '', b: '', dim: '', a: '', u: '', t: '', e: '', s: '' }
  : { d: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', a: '\x1b[36m',
      u: '\x1b[32m', t: '\x1b[33m', e: '\x1b[31m', s: '\x1b[35m' };

const sock = net.createConnection('\\\\.\\pipe\\ompjob-' + name);
sock.setNoDelay(true);

let live = false;          // backlog replayed?
let midDelta = false;      // partial assistant line on screen?
let lastState = '';

function endDelta() { if (midDelta) { process.stdout.write('\n'); midDelta = false; } }

const label = {
  assistant: () => C.a + C.b + 'agent' + C.d,
  user:      () => C.u + 'you' + C.d,
  tool:      () => C.t + 'tool' + C.d,
  'tool-err':() => C.e + 'tool' + C.d,
  error:     () => C.e + 'error' + C.d,
  system:    () => C.s + 'sys' + C.d,
};

function show(kind, text, replay) {
  endDelta();
  const l = (label[kind] || label.system)();
  const pre = replay ? C.dim : '';
  const post = replay ? C.d : '';
  process.stdout.write(pre + l + ' ' + C.dim + '|' + C.d + ' ' + pre + text + post + '\n');
}

sock.on('connect', () => {
  process.stdout.write(C.dim + 'attached to "' + name + '" — replaying history…' + C.d + '\n');
});

let buf = '';
sock.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let f;
    try { f = JSON.parse(line); } catch { continue; }

    if (f.type === 'hello') {
      lastState = f.state;
      process.stdout.write(C.dim + '  job=' + f.name + '  cwd=' + f.cwd +
        '  state=' + f.state + '  turns=' + f.turns + C.d + '\n');
      continue;
    }
    if (f.type === 'live') {
      live = true;
      process.stdout.write(C.dim + '─── live ─── (type to talk · Ctrl+C interrupt · Ctrl+D detach · /status /abort /stop /detach)' + C.d + '\n');
      rl.prompt();
      continue;
    }
    if (f.type === 'render') { show(f.kind, f.text, !live); if (live) rl.prompt(true); continue; }
    if (f.type === 'delta') {
      // Live token stream: only render after backlog, else it double-prints.
      if (!live) continue;
      if (!midDelta) { process.stdout.write('\r\x1b[K' + label.assistant() + ' ' + C.dim + '|' + C.d + ' '); midDelta = true; }
      process.stdout.write(f.text);
      continue;
    }
    if (f.type === 'state') {
      if (f.state !== lastState) {
        lastState = f.state;
        if (live && f.state === 'waiting') { endDelta(); rl.prompt(true); }
      }
      continue;
    }
  }
});

sock.on('error', (e) => {
  const msg = /ENOENT/.test(e.message)
    ? 'job "' + name + '" has no live broker (not running, or already finished).\n' +
      'Try: ompjob list   /   ompjob logs ' + name
    : e.message;
  process.stderr.write(C.e + 'attach failed: ' + C.d + msg + '\n');
  process.exit(1);
});

sock.on('close', () => {
  endDelta();
  process.stdout.write(C.dim + '\ndetached (job keeps running)\n' + C.d);
  process.exit(0);
});

const rl = readline.createInterface({
  input: process.stdin, output: process.stdout,
  prompt: C.u + '> ' + C.d,
  terminal: process.stdout.isTTY,
});

rl.on('line', (raw) => {
  const text = raw.trim();
  if (!text) { rl.prompt(); return; }
  if (text === '/detach' || text === '/exit') { sock.end(); return; }
  if (text === '/status') { sock.write(JSON.stringify({ type: 'status' }) + '\n'); rl.prompt(); return; }
  if (text === '/stop')   { sock.write(JSON.stringify({ type: 'shutdown' }) + '\n'); rl.prompt(); return; }
  if (text === '/abort')  { sock.write(JSON.stringify({ type: 'abort' }) + '\n'); rl.prompt(); return; }
  sock.write(JSON.stringify({ type: 'input', text, who: process.env.USERNAME || 'user' }) + '\n');
  rl.prompt();
});

// Ctrl+C interrupts the agent's turn; it does NOT kill the job.
rl.on('SIGINT', () => {
  endDelta();
  process.stdout.write(C.dim + '(interrupting agent — Ctrl+D to detach)' + C.d + '\n');
  sock.write(JSON.stringify({ type: 'abort', who: process.env.USERNAME || 'user' }) + '\n');
  rl.prompt();
});

// Ctrl+D detaches cleanly.
rl.on('close', () => { sock.end(); });

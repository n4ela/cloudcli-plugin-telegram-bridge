#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const positional = [];
const flags = new Map();
for (const argument of process.argv.slice(2)) {
  if (argument.startsWith('--')) {
    const separator = argument.indexOf('=');
    const key = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    const value = separator === -1 ? 'true' : argument.slice(separator + 1);
    flags.set(key, value);
  } else {
    positional.push(argument);
  }
}

const [sessionId, promptPath] = positional;
if (!sessionId || !promptPath) {
  throw new Error(
    'Usage: run-session.mjs SESSION_ID PROMPT_FILE [--effort=max] [--model=MODEL] [--timeout-seconds=1800]',
  );
}

const configDirectory = process.env.CLOUDCLI_TELEGRAM_CONFIG_DIR
  || path.join(os.homedir(), '.cloudcli', 'telegram-bridge');
const configPath = path.join(configDirectory, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const prompt = fs.readFileSync(path.resolve(promptPath), 'utf8').trim();
const timeoutSeconds = Number(flags.get('timeout-seconds') || 1800);

if (!config.cloudcliWsUrl || !config.cloudcliJwt) {
  throw new Error(`CloudCLI service connection is not configured in ${configPath}`);
}
if (!prompt) throw new Error(`Prompt file is empty: ${promptPath}`);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  throw new Error('--timeout-seconds must be a positive number');
}

const socketUrl = new URL(config.cloudcliWsUrl);
socketUrl.searchParams.set('token', config.cloudcliJwt);

const deadline = Date.now() + timeoutSeconds * 1000;
let socket = null;
let submitted = false;
let reconnectTimer = null;
let statusTimer = null;
let finished = false;

function log(message) {
  process.stdout.write(`[cloudcli-session-run] ${message}\n`);
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (statusTimer) clearTimeout(statusTimer);
  reconnectTimer = null;
  statusTimer = null;
}

function finish(exitCode, message) {
  if (finished) return;
  finished = true;
  clearTimers();
  if (message) (exitCode === 0 ? log : console.error)(message);
  try { socket?.close(); } catch { /* already closed */ }
  process.exitCode = exitCode;
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function subscribe() {
  send({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] });
}

function scheduleStatusCheck() {
  if (finished || submitted || statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    subscribe();
  }, 5_000);
}

function submitPrompt() {
  const options = {};
  const model = flags.get('model');
  const effort = flags.get('effort');
  if (model) options.model = model;
  if (effort) options.effort = effort;

  submitted = true;
  log(`session ${sessionId} is idle; starting the scheduled agent turn`);
  send({
    type: 'chat.send',
    sessionId,
    channelSource: 'automation',
    content: prompt,
    options,
  });
}

function scheduleReconnect() {
  if (finished || reconnectTimer) return;
  if (Date.now() >= deadline) {
    finish(1, `Timed out after ${timeoutSeconds} seconds`);
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2_000);
}

function handleMessage(payload) {
  if (payload.sessionId && payload.sessionId !== sessionId) return;

  if (payload.kind === 'chat_subscribed') {
    if (submitted) {
      if (!payload.isProcessing) {
        finish(0, 'scheduled agent turn finished while the helper was reconnecting');
      }
      return;
    }
    if (payload.isProcessing) {
      log(`session ${sessionId} is busy; waiting`);
      scheduleStatusCheck();
    } else {
      submitPrompt();
    }
    return;
  }

  if (payload.kind === 'protocol_error') {
    if (payload.code === 'RUN_IN_PROGRESS' && submitted) {
      submitted = false;
      log(`session ${sessionId} became busy before dispatch; waiting`);
      subscribe();
      return;
    }
    finish(1, `CloudCLI protocol error: ${payload.code || 'UNKNOWN'} ${payload.error || ''}`.trim());
    return;
  }

  if (submitted && payload.kind === 'complete') {
    const success = payload.success !== false && payload.exitCode !== 1 && !payload.aborted;
    finish(success ? 0 : 1, success
      ? 'scheduled agent turn completed successfully'
      : `scheduled agent turn failed (exitCode=${String(payload.exitCode)}, aborted=${String(payload.aborted)})`);
  }
}

function connect() {
  if (finished) return;
  if (Date.now() >= deadline) {
    finish(1, `Timed out after ${timeoutSeconds} seconds`);
    return;
  }

  socket = new WebSocket(socketUrl);
  socket.addEventListener('open', () => {
    log('connected to CloudCLI');
    subscribe();
  });
  socket.addEventListener('message', (event) => {
    try {
      handleMessage(JSON.parse(String(event.data)));
    } catch (error) {
      finish(1, `Invalid CloudCLI event: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  socket.addEventListener('close', () => {
    if (!finished) scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* already closed */ }
  });
}

const timeoutTimer = setTimeout(() => {
  finish(1, `Timed out after ${timeoutSeconds} seconds`);
}, timeoutSeconds * 1000);
timeoutTimer.unref?.();

process.on('SIGTERM', () => finish(1, 'Terminated'));
process.on('SIGINT', () => finish(1, 'Interrupted'));

connect();

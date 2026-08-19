import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installScheduleUnits,
  readScheduleStatus,
  removeScheduleUnits,
  runScheduleNow,
  setScheduleEnabled,
} from './schedules.js';
import { normalizeLocale, translate } from './i18n.js';
import type { BridgeBinding, BridgeSchedule, BridgeStatus } from './types.js';

type PairCode = {
  code: string;
  sessionId: string;
  sessionTitle: string;
  locale: string;
  expiresAt: number;
};

type BridgeConfig = {
  version: 1;
  botToken: string;
  cloudcliWsUrl: string;
  cloudcliJwt: string;
  bindings: Record<string, BridgeBinding>;
  pairCodes: Record<string, PairCode>;
  schedules: Record<string, BridgeSchedule>;
};

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
};

type TelegramChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
};

type QueuedPrompt = {
  content: string;
  telegramMessageId: number;
};

type TelegramOutboxItem = {
  id: string;
  chatId: number;
  threadId: number;
  text: string;
  silent: boolean;
  attempts: number;
  createdAt: string;
};

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

type CloudCliEvent = Record<string, unknown> & {
  kind?: string;
  code?: string;
  error?: string;
  sessionId?: string;
  channelSource?: string;
  role?: string;
  content?: string;
  seq?: number;
  isProcessing?: boolean;
  permissionMode?: string;
};

const CONFIG_DIRECTORY = process.env.CLOUDCLI_TELEGRAM_CONFIG_DIR
  || path.join(os.homedir(), '.cloudcli', 'telegram-bridge');
const CONFIG_PATH = path.join(CONFIG_DIRECTORY, 'config.json');
const OUTBOX_PATH = path.join(CONFIG_DIRECTORY, 'outbox.json');
const SCHEDULES_DIRECTORY = path.join(CONFIG_DIRECTORY, 'schedules');
const PLUGIN_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEDULE_WORKER_PATH = path.join(PLUGIN_DIRECTORY, 'scripts', 'execute-schedule.mjs');
const TELEGRAM_MESSAGE_LIMIT = 3900;
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_STATUS_RECHECK_MS = 2_000;
const BUSY_NOTICE_DELAY_MS = 1_200;
const OUTBOX_RETRY_MIN_MS = 2_000;
const OUTBOX_RETRY_MAX_MS = 30_000;

let config = loadConfig();
let telegramOutbox = loadTelegramOutbox();
let telegramOutboxRunning = false;
let telegramOutboxTimer: NodeJS.Timeout | null = null;
let cloudcliSocket: WebSocket | null = null;
let cloudcliReconnectTimer: NodeJS.Timeout | null = null;
let cloudcliReconnectAttempt = 0;
let telegramAbortController: AbortController | null = null;
let telegramConnected = false;
let telegramBotUsername: string | null = null;
let telegramOffset = 0;
let lastError: string | null = null;

const processingSessions = new Set<string>();
const promptQueues = new Map<string, QueuedPrompt[]>();
const inFlightPrompts = new Map<string, QueuedPrompt>();
const automationSessions = new Set<string>();
const streamBuffers = new Map<string, string>();
const lastSequenceBySession = new Map<string, number>();
const sessionStatusRecheckTimers = new Map<string, NodeJS.Timeout>();
const permissionModesBySession = new Map<string, string>();
const telegramOutboxWaiters = new Map<string, {
  resolve: () => void;
  reject: (error: unknown) => void;
}>();

const TELEGRAM_PERMISSION_MODES: Record<string, string> = {
  safe: 'default',
  project: 'acceptEdits',
  full: 'bypassPermissions',
};

function permissionModeLabel(permissionMode: string | undefined, locale: string): string {
  if (permissionMode === 'bypassPermissions') return translate(locale, 'bot.permissionFull');
  if (permissionMode === 'acceptEdits') return translate(locale, 'bot.permissionProject');
  if (permissionMode === 'default') return translate(locale, 'bot.permissionSafe');
  return permissionMode || translate(locale, 'bot.permissionUnknown');
}

function defaultConfig(): BridgeConfig {
  return {
    version: 1,
    botToken: '',
    cloudcliWsUrl: '',
    cloudcliJwt: '',
    bindings: {},
    pairCodes: {},
    schedules: {},
  };
}

function loadConfig(): BridgeConfig {
  try {
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<BridgeConfig>;
    return {
      ...defaultConfig(),
      ...stored,
      bindings: stored.bindings ?? {},
      pairCodes: stored.pairCodes ?? {},
      schedules: stored.schedules ?? {},
    };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(): void {
  fs.mkdirSync(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
  const temporaryPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, CONFIG_PATH);
  fs.chmodSync(CONFIG_PATH, 0o600);
}

function loadTelegramOutbox(): TelegramOutboxItem[] {
  try {
    const stored = JSON.parse(fs.readFileSync(OUTBOX_PATH, 'utf8')) as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is TelegramOutboxItem => Boolean(
      item
      && typeof item === 'object'
      && typeof item.id === 'string'
      && typeof item.chatId === 'number'
      && typeof item.threadId === 'number'
      && typeof item.text === 'string'
      && typeof item.silent === 'boolean'
      && typeof item.attempts === 'number'
      && typeof item.createdAt === 'string',
    ));
  } catch {
    return [];
  }
}

function saveTelegramOutbox(): void {
  fs.mkdirSync(CONFIG_DIRECTORY, { recursive: true, mode: 0o700 });
  const temporaryPath = `${OUTBOX_PATH}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(telegramOutbox, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, OUTBOX_PATH);
  fs.chmodSync(OUTBOX_PATH, 0o600);
}

function recordError(error: unknown): void {
  lastError = error instanceof Error ? error.message : String(error);
  console.error(`[TelegramBridge] ${lastError}`);
}

function bindingKey(chatId: number, threadId = 0): string {
  return `${chatId}:${threadId}`;
}

function chatTitle(chat: TelegramChat, threadId: number, locale = 'en'): string {
  const base = chat.title
    || [chat.first_name, chat.last_name].filter(Boolean).join(' ')
    || chat.username
    || String(chat.id);
  return threadId ? translate(locale, 'bot.topic', { name: base, threadId }) : base;
}

function telegramUserLocale(message: TelegramMessage): string {
  return normalizeLocale(message.from?.language_code);
}

function activeBindingsForSession(sessionId: string): BridgeBinding[] {
  return Object.values(config.bindings).filter((binding) => binding.sessionId === sessionId);
}

function cleanExpiredPairCodes(): void {
  const now = Date.now();
  let changed = false;
  for (const [code, pair] of Object.entries(config.pairCodes)) {
    if (pair.expiresAt <= now) {
      delete config.pairCodes[code];
      changed = true;
    }
  }
  if (changed) saveConfig();
}

const SCHEDULE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function schedulePromptPath(id: string): string {
  return path.join(SCHEDULES_DIRECTORY, `${id}.md`);
}

function writeSchedulePrompt(schedule: BridgeSchedule): void {
  fs.mkdirSync(SCHEDULES_DIRECTORY, { recursive: true, mode: 0o700 });
  const destination = schedulePromptPath(schedule.id);
  const temporaryPath = `${destination}.tmp`;
  fs.writeFileSync(temporaryPath, `${schedule.prompt.trim()}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, destination);
  fs.chmodSync(destination, 0o600);
}

function readRequiredText(
  body: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (!value) throw new Error(`${label} is required`);
  if (value.length > maxLength) throw new Error(`${label} is too long`);
  return value;
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error('Unknown timezone');
  }
}

function validateDailyTime(time: string): void {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error('Time must use HH:MM format');
  }
}

function scheduleFromBody(body: Record<string, unknown>): BridgeSchedule {
  const name = readRequiredText(body, 'name', 'Name', 120);
  const sessionId = readRequiredText(body, 'sessionId', 'Session', 200);
  const sessionTitle = typeof body.sessionTitle === 'string' && body.sessionTitle.trim()
    ? body.sessionTitle.trim().slice(0, 200)
    : sessionId;
  const prompt = readRequiredText(body, 'prompt', 'Task', 60_000);
  const time = readRequiredText(body, 'time', 'Time', 5);
  const timezone = typeof body.timezone === 'string' && body.timezone.trim()
    ? body.timezone.trim()
    : 'Europe/Moscow';
  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim().slice(0, 100)
    : '';
  const effort = typeof body.effort === 'string' && SCHEDULE_EFFORTS.has(body.effort)
    ? body.effort
    : '';
  const workingDirectory = typeof body.workingDirectory === 'string' && body.workingDirectory.trim()
    ? body.workingDirectory.trim()
    : undefined;
  const preCommand = Array.isArray(body.preCommand)
    ? body.preCommand.map((part) => typeof part === 'string' ? part : '').filter(Boolean)
    : undefined;

  validateDailyTime(time);
  validateTimezone(timezone);
  if (workingDirectory && !path.isAbsolute(workingDirectory)) {
    throw new Error('Working directory must be an absolute path');
  }
  if (preCommand?.length) {
    if (preCommand.length > 32 || preCommand.some((part) => part.length > 2_000)) {
      throw new Error('Pre-command is too long');
    }
    if (!path.isAbsolute(preCommand[0])) {
      throw new Error('Pre-command executable must be an absolute path');
    }
  }

  let id = '';
  do id = randomUUID().replaceAll('-', '').slice(0, 12); while (config.schedules[id]);
  const timestamp = new Date().toISOString();
  return {
    id,
    name,
    sessionId,
    sessionTitle,
    prompt,
    time,
    timezone,
    model,
    effort,
    enabled: body.enabled !== false,
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(preCommand?.length ? { preCommand } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function telegramApi<T>(method: string, payload: Record<string, unknown> = {}, token = config.botToken): Promise<T> {
  if (!token) throw new Error('Telegram bot token is not configured');
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json() as TelegramResponse<T>;
  if (!response.ok || !result.ok || result.result === undefined) {
    const status = result.error_code ?? response.status;
    throw new TelegramApiError(
      result.description || `Telegram ${method} failed with HTTP ${status}`,
      status === 429 || status >= 500,
      typeof result.parameters?.retry_after === 'number'
        ? result.parameters.retry_after * 1_000
        : undefined,
    );
  }
  return result.result;
}

function splitTelegramText(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return [text];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MESSAGE_LIMIT) {
    let boundary = remaining.lastIndexOf('\n', TELEGRAM_MESSAGE_LIMIT);
    if (boundary < TELEGRAM_MESSAGE_LIMIT / 2) boundary = remaining.lastIndexOf(' ', TELEGRAM_MESSAGE_LIMIT);
    if (boundary < TELEGRAM_MESSAGE_LIMIT / 2) boundary = TELEGRAM_MESSAGE_LIMIT;
    parts.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function scheduleTelegramOutboxRetry(delay: number): void {
  if (telegramOutboxTimer) return;
  telegramOutboxTimer = setTimeout(() => {
    telegramOutboxTimer = null;
    void flushTelegramOutbox();
  }, delay);
  telegramOutboxTimer.unref?.();
}

async function flushTelegramOutbox(): Promise<void> {
  if (telegramOutboxRunning || !telegramOutbox.length) return;
  telegramOutboxRunning = true;

  try {
    while (telegramOutbox.length) {
      const item = telegramOutbox[0];
      const payload: Record<string, unknown> = {
        chat_id: item.chatId,
        text: item.text,
        disable_web_page_preview: true,
        disable_notification: item.silent,
      };
      if (item.threadId) payload.message_thread_id = item.threadId;

      try {
        await telegramApi('sendMessage', payload);
        telegramOutbox.shift();
        saveTelegramOutbox();
        telegramOutboxWaiters.get(item.id)?.resolve();
        telegramOutboxWaiters.delete(item.id);
      } catch (error) {
        recordError(error);
        if (error instanceof TelegramApiError && !error.retryable) {
          telegramOutbox.shift();
          saveTelegramOutbox();
          telegramOutboxWaiters.get(item.id)?.reject(error);
          telegramOutboxWaiters.delete(item.id);
          continue;
        }

        item.attempts += 1;
        saveTelegramOutbox();
        const exponentialDelay = Math.min(
          OUTBOX_RETRY_MAX_MS,
          OUTBOX_RETRY_MIN_MS * 2 ** Math.min(item.attempts - 1, 4),
        );
        const retryDelay = error instanceof TelegramApiError && error.retryAfterMs
          ? Math.max(exponentialDelay, error.retryAfterMs)
          : exponentialDelay;
        scheduleTelegramOutboxRetry(retryDelay);
        return;
      }
    }
  } finally {
    telegramOutboxRunning = false;
  }
}

function enqueueTelegramPart(
  binding: BridgeBinding,
  text: string,
  options: { silent?: boolean },
): Promise<void> {
  const item: TelegramOutboxItem = {
    id: randomUUID(),
    chatId: binding.chatId,
    threadId: binding.threadId,
    text,
    silent: Boolean(options.silent),
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  telegramOutbox.push(item);
  saveTelegramOutbox();

  const completion = new Promise<void>((resolve, reject) => {
    telegramOutboxWaiters.set(item.id, { resolve, reject });
  });
  void flushTelegramOutbox();
  return completion;
}

async function sendTelegramText(
  binding: BridgeBinding,
  text: string,
  options: { silent?: boolean } = {},
): Promise<void> {
  for (const part of splitTelegramText(text)) {
    await enqueueTelegramPart(binding, part, options);
  }
}

async function sendTelegramMessage(message: TelegramMessage, text: string): Promise<void> {
  const syntheticBinding: BridgeBinding = {
    key: bindingKey(message.chat.id, message.message_thread_id ?? 0),
    chatId: message.chat.id,
    threadId: message.message_thread_id ?? 0,
    chatTitle: chatTitle(message.chat, message.message_thread_id ?? 0),
    sessionId: '',
    sessionTitle: '',
    ownerUserId: message.from?.id ?? 0,
    createdAt: new Date().toISOString(),
  };
  await sendTelegramText(syntheticBinding, text);
}

async function mirrorToSessionBindings(
  sessionId: string,
  text: string,
  options: { silent?: boolean } = {},
): Promise<void> {
  const results = await Promise.allSettled(
    activeBindingsForSession(sessionId).map((binding) => sendTelegramText(binding, text, options)),
  );
  for (const result of results) {
    if (result.status === 'rejected') recordError(result.reason);
  }
}

function cloudcliSocketUrl(): string {
  const url = new URL(config.cloudcliWsUrl);
  url.searchParams.set('token', config.cloudcliJwt);
  return url.toString();
}

function subscribeToBoundSessions(): void {
  if (!cloudcliSocket || cloudcliSocket.readyState !== WebSocket.OPEN) return;
  const sessionIds = [...new Set(Object.values(config.bindings).map((binding) => binding.sessionId))];
  if (!sessionIds.length) return;
  cloudcliSocket.send(JSON.stringify({
    type: 'chat.subscribe',
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      lastSeq: lastSequenceBySession.get(sessionId) ?? 0,
    })),
  }));
}

function requestSessionStatus(sessionId: string): void {
  if (!cloudcliSocket || cloudcliSocket.readyState !== WebSocket.OPEN) return;
  cloudcliSocket.send(JSON.stringify({
    type: 'chat.subscribe',
    sessions: [{ sessionId, lastSeq: lastSequenceBySession.get(sessionId) ?? 0 }],
  }));
}

function cancelSessionStatusRecheck(sessionId: string): void {
  const timer = sessionStatusRecheckTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  sessionStatusRecheckTimers.delete(sessionId);
}

function scheduleSessionStatusRecheck(sessionId: string): void {
  if (sessionStatusRecheckTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    sessionStatusRecheckTimers.delete(sessionId);
    const hasQueuedPrompt = (promptQueues.get(sessionId)?.length ?? 0) > 0;
    if (!hasQueuedPrompt || inFlightPrompts.has(sessionId)) return;
    requestSessionStatus(sessionId);
    if (processingSessions.has(sessionId)) scheduleSessionStatusRecheck(sessionId);
  }, SESSION_STATUS_RECHECK_MS);
  timer.unref?.();
  sessionStatusRecheckTimers.set(sessionId, timer);
}

function scheduleCloudCliReconnect(): void {
  if (cloudcliReconnectTimer) return;
  const delay = Math.min(30_000, 1_000 * 2 ** Math.min(cloudcliReconnectAttempt, 5));
  cloudcliReconnectAttempt += 1;
  cloudcliReconnectTimer = setTimeout(() => {
    cloudcliReconnectTimer = null;
    connectCloudCli();
  }, delay);
  cloudcliReconnectTimer.unref?.();
}

function connectCloudCli(): void {
  if (!config.cloudcliWsUrl || !config.cloudcliJwt) return;
  if (cloudcliSocket?.readyState === WebSocket.OPEN || cloudcliSocket?.readyState === WebSocket.CONNECTING) return;

  try {
    const socket = new WebSocket(cloudcliSocketUrl());
    cloudcliSocket = socket;

    socket.addEventListener('open', () => {
      cloudcliReconnectAttempt = 0;
      lastError = null;
      subscribeToBoundSessions();
    });
    socket.addEventListener('message', (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as CloudCliEvent;
        void handleCloudCliEvent(payload).catch(recordError);
      } catch (error) {
        recordError(error);
      }
    });
    socket.addEventListener('close', () => {
      if (cloudcliSocket === socket) cloudcliSocket = null;
      scheduleCloudCliReconnect();
    });
    socket.addEventListener('error', () => {
      if (cloudcliSocket === socket) cloudcliSocket = null;
      try { socket.close(); } catch { /* already closed */ }
      scheduleCloudCliReconnect();
    });
  } catch (error) {
    recordError(error);
    cloudcliSocket = null;
    scheduleCloudCliReconnect();
  }
}

function enqueueTelegramPrompt(binding: BridgeBinding, prompt: QueuedPrompt): void {
  const queue = promptQueues.get(binding.sessionId) ?? [];
  queue.push(prompt);
  promptQueues.set(binding.sessionId, queue);
  sendNextPrompt(binding.sessionId);
  if (processingSessions.has(binding.sessionId) && !inFlightPrompts.has(binding.sessionId)) {
    // A terminal websocket event can be lost during a reconnect. Ask CloudCLI
    // for its authoritative run state immediately and keep polling while a
    // Telegram prompt is waiting, so a stale busy flag cannot block forever.
    requestSessionStatus(binding.sessionId);
    scheduleSessionStatusRecheck(binding.sessionId);
  }
}

function sendNextPrompt(sessionId: string): void {
  if (processingSessions.has(sessionId) || inFlightPrompts.has(sessionId)) return;
  if (!cloudcliSocket || cloudcliSocket.readyState !== WebSocket.OPEN) return;
  const queue = promptQueues.get(sessionId);
  const next = queue?.shift();
  if (!next) return;

  inFlightPrompts.set(sessionId, next);
  processingSessions.add(sessionId);
  cloudcliSocket.send(JSON.stringify({
    type: 'chat.send',
    sessionId,
    content: next.content,
    channelSource: 'telegram',
  }));
}

function assistantDeliveryIsSilent(sessionId: string): boolean {
  return !inFlightPrompts.has(sessionId) && !automationSessions.has(sessionId);
}

async function handleCloudCliEvent(event: CloudCliEvent): Promise<void> {
  const sessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
  if (sessionId && typeof event.seq === 'number') {
    let previous = lastSequenceBySession.get(sessionId) ?? 0;
    // Sequence numbers restart at 1 for every provider run. A bridge can miss
    // the previous run's terminal `complete` while its CloudCLI socket is
    // reconnecting; without this boundary check, the retained high-water mark
    // makes it discard the entire next reply as an old replay.
    if (event.seq === 1 && previous > 0) {
      previous = 0;
      lastSequenceBySession.delete(sessionId);
      streamBuffers.delete(sessionId);
    }
    if (event.seq <= previous) return;
    lastSequenceBySession.set(sessionId, event.seq);
  }

  if (event.kind === 'chat_subscribed' && sessionId) {
    if (typeof event.permissionMode === 'string') {
      permissionModesBySession.set(sessionId, event.permissionMode);
    }
    if (event.isProcessing) {
      processingSessions.add(sessionId);
      if ((promptQueues.get(sessionId)?.length ?? 0) > 0 && !inFlightPrompts.has(sessionId)) {
        scheduleSessionStatusRecheck(sessionId);
      }
    }
    else {
      cancelSessionStatusRecheck(sessionId);
      processingSessions.delete(sessionId);
      // CloudCLI sequences events per provider run. Once the session is idle,
      // the next run starts at seq=1 again, so retaining the previous run's
      // high-water mark would make the bridge discard the next reply.
      lastSequenceBySession.delete(sessionId);
      sendNextPrompt(sessionId);
    }
    return;
  }

  if (event.kind === 'session_permission_mode' && sessionId) {
    if (typeof event.permissionMode === 'string') {
      permissionModesBySession.set(sessionId, event.permissionMode);
    }
    return;
  }

  if (event.kind === 'protocol_error' && sessionId) {
    const inFlight = inFlightPrompts.get(sessionId);
    inFlightPrompts.delete(sessionId);
    if (event.code === 'RUN_IN_PROGRESS') {
      if (inFlight) {
        const queue = promptQueues.get(sessionId) ?? [];
        queue.unshift(inFlight);
        promptQueues.set(sessionId, queue);
      }
      processingSessions.add(sessionId);
      requestSessionStatus(sessionId);
      scheduleSessionStatusRecheck(sessionId);
      return;
    }
    processingSessions.delete(sessionId);
    cancelSessionStatusRecheck(sessionId);
    for (const binding of activeBindingsForSession(sessionId)) {
      await sendTelegramText(
        binding,
        `⚠️ CloudCLI: ${String(event.error || translate(binding.locale, 'bot.cloudSendFailed'))}`,
      );
    }
    sendNextPrompt(sessionId);
    return;
  }

  if (!sessionId || activeBindingsForSession(sessionId).length === 0) return;

  if (event.kind === 'text' && event.role === 'user' && event.content) {
    const isAutomation = event.channelSource === 'automation';
    if (isAutomation) automationSessions.add(sessionId);
    await Promise.all(activeBindingsForSession(sessionId).map((binding) => {
      const sourceLabel = translate(binding.locale, isAutomation ? 'bot.automation' : 'bot.webuiUser');
      return sendTelegramText(binding, `${sourceLabel}\n\n${event.content}`, { silent: true });
    }));
    return;
  }

  if (event.kind === 'text' && event.role === 'assistant' && event.content) {
    streamBuffers.delete(sessionId);
    await Promise.all(activeBindingsForSession(sessionId).map((binding) => sendTelegramText(
      binding,
      `${translate(binding.locale, 'bot.agent')}\n\n${event.content}`,
      { silent: assistantDeliveryIsSilent(sessionId) },
    )));
    return;
  }

  if (event.kind === 'stream_delta' && event.content) {
    streamBuffers.set(sessionId, `${streamBuffers.get(sessionId) ?? ''}${event.content}`);
    return;
  }

  if (event.kind === 'stream_end') {
    const buffered = streamBuffers.get(sessionId);
    streamBuffers.delete(sessionId);
    if (buffered) {
      await Promise.all(activeBindingsForSession(sessionId).map((binding) => sendTelegramText(
        binding,
        `${translate(binding.locale, 'bot.agent')}\n\n${buffered}`,
        { silent: assistantDeliveryIsSilent(sessionId) },
      )));
    }
    return;
  }

  if (event.kind === 'error') {
    await Promise.all(activeBindingsForSession(sessionId).map((binding) => sendTelegramText(
      binding,
      `${translate(binding.locale, 'bot.agentError')}: ${String(event.content || translate(binding.locale, 'bot.agentUnknownError'))}`,
    )));
    return;
  }

  if (event.kind === 'complete') {
    const buffered = streamBuffers.get(sessionId);
    streamBuffers.delete(sessionId);
    if (buffered) {
      await Promise.all(activeBindingsForSession(sessionId).map((binding) => sendTelegramText(
        binding,
        `${translate(binding.locale, 'bot.agent')}\n\n${buffered}`,
        { silent: assistantDeliveryIsSilent(sessionId) },
      )));
    }
    processingSessions.delete(sessionId);
    // `seq` is scoped to this completed run, not to the lifetime of the app
    // session. Reset before another WebUI or Telegram prompt starts a run.
    lastSequenceBySession.delete(sessionId);
    cancelSessionStatusRecheck(sessionId);
    inFlightPrompts.delete(sessionId);
    automationSessions.delete(sessionId);
    sendNextPrompt(sessionId);
  }
}

async function bindTelegramChat(message: TelegramMessage, code: string): Promise<void> {
  cleanExpiredPairCodes();
  const pair = config.pairCodes[code];
  if (!pair) {
    await sendTelegramMessage(message, translate(telegramUserLocale(message), 'bot.invalidPairCode'));
    return;
  }
  const locale = normalizeLocale(pair.locale || telegramUserLocale(message));
  if (!message.from?.id) {
    await sendTelegramMessage(message, translate(locale, 'bot.ownerUnknown'));
    return;
  }

  const threadId = message.message_thread_id ?? 0;
  const key = bindingKey(message.chat.id, threadId);
  config.bindings[key] = {
    key,
    chatId: message.chat.id,
    threadId,
    chatTitle: chatTitle(message.chat, threadId, locale),
    sessionId: pair.sessionId,
    sessionTitle: pair.sessionTitle,
    ownerUserId: message.from.id,
    locale,
    createdAt: new Date().toISOString(),
  };
  delete config.pairCodes[code];
  saveConfig();
  subscribeToBoundSessions();
  await sendTelegramMessage(message, translate(locale, 'bot.bound', { session: pair.sessionTitle }));
}

async function handleTelegramMessage(message: TelegramMessage): Promise<void> {
  const text = message.text?.trim();
  if (!text || message.from?.is_bot) return;

  const [rawCommand, ...argumentsList] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split('@')[0];
  if (command === '/bind') {
    await bindTelegramChat(message, argumentsList[0] ?? '');
    return;
  }

  const key = bindingKey(message.chat.id, message.message_thread_id ?? 0);
  const binding = config.bindings[key];
  const locale = normalizeLocale(binding?.locale || telegramUserLocale(message));

  if (command === '/help' || command === '/start') {
    await sendTelegramMessage(message, binding
      ? translate(locale, 'bot.helpBound', { session: binding.sessionTitle })
      : translate(locale, 'bot.helpUnbound'));
    return;
  }
  if (command === '/where') {
    await sendTelegramMessage(message, binding
      ? translate(locale, 'bot.statusBound', { session: binding.sessionTitle, id: binding.sessionId })
      : translate(locale, 'bot.statusUnbound'));
    return;
  }
  if (command === '/unbind') {
    if (binding && message.from?.id === binding.ownerUserId) {
      delete config.bindings[key];
      saveConfig();
      await sendTelegramMessage(message, translate(locale, 'bot.bindingRemoved'));
    }
    return;
  }
  if (command === '/mode') {
    if (!binding) {
      await sendTelegramMessage(message, translate(locale, 'bot.unboundMode'));
      return;
    }
    if (message.from?.id !== binding.ownerUserId) {
      await sendTelegramMessage(message, translate(locale, 'bot.ownerOnlyMode'));
      return;
    }

    const requestedName = (argumentsList[0] ?? '').toLowerCase();
    if (!requestedName) {
      requestSessionStatus(binding.sessionId);
      await sendTelegramMessage(
        message,
        translate(locale, 'bot.currentMode', {
          mode: permissionModeLabel(permissionModesBySession.get(binding.sessionId), locale),
        }),
      );
      return;
    }

    const requestedMode = TELEGRAM_PERMISSION_MODES[requestedName];
    if (!requestedMode) {
      await sendTelegramMessage(message, translate(locale, 'bot.unknownMode'));
      return;
    }
    if (!cloudcliSocket || cloudcliSocket.readyState !== WebSocket.OPEN) {
      await sendTelegramMessage(message, translate(locale, 'bot.cloudReconnectingRetry'));
      return;
    }

    cloudcliSocket.send(JSON.stringify({
      type: 'chat.permission-mode',
      sessionId: binding.sessionId,
      permissionMode: requestedMode,
    }));
    permissionModesBySession.set(binding.sessionId, requestedMode);
    await sendTelegramMessage(message, translate(locale, 'bot.modeChanged', {
      mode: permissionModeLabel(requestedMode, locale),
    }));
    return;
  }
  if (text.startsWith('/')) return;

  if (!binding) {
    await sendTelegramMessage(message, translate(locale, 'bot.unboundShort'));
    return;
  }
  if (message.from?.id !== binding.ownerUserId) {
    await sendTelegramMessage(message, translate(locale, 'bot.ownerOnly'));
    return;
  }

  const prompt = { content: text, telegramMessageId: message.message_id };
  enqueueTelegramPrompt(binding, prompt);
  if (!cloudcliSocket || cloudcliSocket.readyState !== WebSocket.OPEN) {
    await sendTelegramMessage(message, translate(locale, 'bot.cloudReconnectingQueued'));
  } else if (processingSessions.has(binding.sessionId) && !inFlightPrompts.has(binding.sessionId)) {
    const timer = setTimeout(() => {
      const stillQueued = promptQueues.get(binding.sessionId)?.includes(prompt) ?? false;
      if (stillQueued && processingSessions.has(binding.sessionId) && !inFlightPrompts.has(binding.sessionId)) {
        void sendTelegramMessage(message, translate(locale, 'bot.sessionBusyQueued')).catch(recordError);
      }
    }, BUSY_NOTICE_DELAY_MS);
    timer.unref?.();
  }
}

async function telegramPollingLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted && config.botToken) {
    try {
      const updates = await telegramApi<TelegramUpdate[]>('getUpdates', {
        offset: telegramOffset,
        timeout: 30,
        allowed_updates: ['message'],
      });
      telegramConnected = true;
      lastError = null;
      for (const update of updates) {
        telegramOffset = Math.max(telegramOffset, update.update_id + 1);
        if (update.message) await handleTelegramMessage(update.message);
      }
    } catch (error) {
      if (signal.aborted) return;
      telegramConnected = false;
      recordError(error);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

async function startTelegram(token = config.botToken): Promise<{ username: string } | null> {
  telegramAbortController?.abort();
  telegramAbortController = null;
  telegramConnected = false;
  telegramBotUsername = null;
  if (!token) return null;

  const bot = await telegramApi<TelegramUser>('getMe', {}, token);
  await telegramApi('deleteWebhook', { drop_pending_updates: false }, token);
  telegramBotUsername = bot.username ?? null;
  telegramAbortController = new AbortController();
  void telegramPollingLoop(telegramAbortController.signal);
  return { username: bot.username ?? String(bot.id) };
}

function status(): BridgeStatus {
  return {
    botConfigured: Boolean(config.botToken),
    botUsername: telegramBotUsername,
    telegramConnected,
    cloudcliConnected: cloudcliSocket?.readyState === WebSocket.OPEN,
    serviceConfigured: Boolean(config.cloudcliWsUrl && config.cloudcliJwt),
    bindings: Object.values(config.bindings).map((binding) => ({
      ...binding,
      permissionMode: permissionModesBySession.get(binding.sessionId),
    })),
    outboxPending: telegramOutbox.length,
    lastError,
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/status') {
      writeJson(response, 200, status());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/schedules') {
      const schedules = await Promise.all(
        Object.values(config.schedules).map((schedule) => readScheduleStatus(schedule)),
      );
      schedules.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      writeJson(response, 200, { schedules });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/schedules') {
      const schedule = scheduleFromBody(await readJsonBody(request));
      config.schedules[schedule.id] = schedule;
      writeSchedulePrompt(schedule);
      saveConfig();
      try {
        await installScheduleUnits(schedule, SCHEDULE_WORKER_PATH);
      } catch (caught) {
        delete config.schedules[schedule.id];
        saveConfig();
        fs.rmSync(schedulePromptPath(schedule.id), { force: true });
        await removeScheduleUnits(schedule.id).catch(() => undefined);
        throw caught;
      }
      writeJson(response, 201, await readScheduleStatus(schedule));
      return;
    }
    const scheduleRoute = /^\/schedules\/([a-f0-9]{12})(?:\/(run|enabled))?$/.exec(url.pathname);
    if (scheduleRoute) {
      const scheduleId = scheduleRoute[1];
      const action = scheduleRoute[2] ?? '';
      const schedule = config.schedules[scheduleId];
      if (!schedule) {
        writeJson(response, 404, { error: 'Schedule not found' });
        return;
      }
      if (request.method === 'POST' && action === 'run') {
        await runScheduleNow(scheduleId);
        writeJson(response, 202, { success: true });
        return;
      }
      if (request.method === 'PUT' && action === 'enabled') {
        const body = await readJsonBody(request);
        if (typeof body.enabled !== 'boolean') {
          writeJson(response, 400, { error: 'enabled must be boolean' });
          return;
        }
        const previous = schedule.enabled;
        schedule.enabled = body.enabled;
        schedule.updatedAt = new Date().toISOString();
        saveConfig();
        try {
          await setScheduleEnabled(scheduleId, schedule.enabled);
        } catch (caught) {
          schedule.enabled = previous;
          saveConfig();
          throw caught;
        }
        writeJson(response, 200, await readScheduleStatus(schedule));
        return;
      }
      if (request.method === 'DELETE' && !action) {
        await removeScheduleUnits(scheduleId);
        delete config.schedules[scheduleId];
        saveConfig();
        fs.rmSync(schedulePromptPath(scheduleId), { force: true });
        writeJson(response, 200, { success: true });
        return;
      }
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const body = await readJsonBody(request);
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
        writeJson(response, 400, { error: 'Invalid Telegram token format' });
        return;
      }
      const previousToken = config.botToken;
      config.botToken = token;
      try {
        const bot = await startTelegram(token);
        saveConfig();
        writeJson(response, 200, bot);
      } catch (caught) {
        config.botToken = previousToken;
        void startTelegram(previousToken).catch(recordError);
        throw caught;
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/notify') {
      const body = await readJsonBody(request);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const notificationText = typeof body.text === 'string' ? body.text.trim() : '';
      if (!sessionId || !notificationText) {
        writeJson(response, 400, { error: 'sessionId and text are required' });
        return;
      }

      const bindings = activeBindingsForSession(sessionId);
      if (!bindings.length) {
        writeJson(response, 404, { error: 'No Telegram chat is bound to this session' });
        return;
      }

      await mirrorToSessionBindings(sessionId, notificationText, {
        silent: body.silent === true,
      });
      writeJson(response, 200, { success: true, deliveredTo: bindings.length });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/pair') {
      if (!config.botToken) {
        writeJson(response, 400, { error: 'Save the Telegram bot token first' });
        return;
      }
      const body = await readJsonBody(request);
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
      const sessionTitle = typeof body.sessionTitle === 'string' && body.sessionTitle.trim()
        ? body.sessionTitle.trim()
        : sessionId;
      const locale = normalizeLocale(typeof body.locale === 'string' ? body.locale : 'en');
      if (!sessionId) {
        writeJson(response, 400, { error: 'Open a CloudCLI session before creating a code' });
        return;
      }
      cleanExpiredPairCodes();
      let code = '';
      do code = String(randomInt(100_000, 1_000_000)); while (config.pairCodes[code]);
      config.pairCodes[code] = {
        code,
        sessionId,
        sessionTitle,
        locale,
        expiresAt: Date.now() + PAIR_CODE_TTL_MS,
      };
      saveConfig();
      writeJson(response, 200, { code, expiresInSeconds: PAIR_CODE_TTL_MS / 1000 });
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/bindings') {
      const key = url.searchParams.get('key') ?? '';
      if (!config.bindings[key]) {
        writeJson(response, 404, { error: 'Binding not found' });
        return;
      }
      delete config.bindings[key];
      saveConfig();
      writeJson(response, 200, { success: true });
      return;
    }
    writeJson(response, 404, { error: 'Not found' });
  } catch (error) {
    recordError(error);
    writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(JSON.stringify({ ready: true, port: address.port }));
  }
  connectCloudCli();
  void flushTelegramOutbox();
  void startTelegram().catch(recordError);
});

function shutdown(): void {
  telegramAbortController?.abort();
  if (telegramOutboxTimer) clearTimeout(telegramOutboxTimer);
  if (cloudcliReconnectTimer) clearTimeout(cloudcliReconnectTimer);
  for (const timer of sessionStatusRecheckTimers.values()) clearTimeout(timer);
  sessionStatusRecheckTimers.clear();
  try { cloudcliSocket?.close(); } catch { /* already closed */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

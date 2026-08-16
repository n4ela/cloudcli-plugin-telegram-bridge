import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BridgeSchedule, BridgeScheduleStatus } from './types.js';

const execFileAsync = promisify(execFile);
const SYSTEMCTL = process.env.CLOUDCLI_SYSTEMCTL_PATH || '/usr/bin/systemctl';
const SYSTEMD_DIRECTORY = process.env.CLOUDCLI_SYSTEMD_DIRECTORY || '/etc/systemd/system';
const UNIT_PREFIX = 'cloudcli-schedule-';

function assertScheduleId(id: string): void {
  if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Invalid schedule id');
}

function systemdQuote(value: string): string {
  return JSON.stringify(value);
}

function safeDescription(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
}

function unitBase(id: string): string {
  assertScheduleId(id);
  return `${UNIT_PREFIX}${id}`;
}

function unitPaths(id: string): { service: string; timer: string } {
  const base = unitBase(id);
  return {
    service: path.join(SYSTEMD_DIRECTORY, `${base}.service`),
    timer: path.join(SYSTEMD_DIRECTORY, `${base}.timer`),
  };
}

function writeAtomic(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, content, { mode: 0o644 });
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o644);
}

async function systemctl(...arguments_: string[]): Promise<string> {
  const result = await execFileAsync(SYSTEMCTL, arguments_, { maxBuffer: 1024 * 1024 });
  return result.stdout;
}

async function systemctlAllowFailure(...arguments_: string[]): Promise<string> {
  try {
    return await systemctl(...arguments_);
  } catch {
    return '';
  }
}

function parseProperties(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function timestampToIso(value: string | undefined): string | null {
  if (!value || value === 'n/a') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export async function installScheduleUnits(schedule: BridgeSchedule, workerPath: string): Promise<void> {
  const base = unitBase(schedule.id);
  const paths = unitPaths(schedule.id);
  const calendar = `*-*-* ${schedule.time}:00 ${schedule.timezone}`;
  const nodePath = process.execPath;

  const service = `[Unit]\nDescription=CloudCLI schedule: ${safeDescription(schedule.name)}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=oneshot\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(workerPath)} ${systemdQuote(schedule.id)}\nNice=10\n`;
  const timer = `[Unit]\nDescription=Timer for CloudCLI schedule: ${safeDescription(schedule.name)}\n\n[Timer]\nOnCalendar=${calendar}\nPersistent=true\nRandomizedDelaySec=30\nUnit=${base}.service\n\n[Install]\nWantedBy=timers.target\n`;

  writeAtomic(paths.service, service);
  writeAtomic(paths.timer, timer);
  await systemctl('daemon-reload');
  if (schedule.enabled) {
    await systemctl('enable', '--now', `${base}.timer`);
  } else {
    await systemctlAllowFailure('disable', '--now', `${base}.timer`);
  }
}

export async function setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
  const timer = `${unitBase(id)}.timer`;
  if (enabled) await systemctl('enable', '--now', timer);
  else await systemctlAllowFailure('disable', '--now', timer);
}

export async function runScheduleNow(id: string): Promise<void> {
  await systemctl('start', '--no-block', `${unitBase(id)}.service`);
}

export async function removeScheduleUnits(id: string): Promise<void> {
  const base = unitBase(id);
  const paths = unitPaths(id);
  await systemctlAllowFailure('disable', '--now', `${base}.timer`);
  await systemctlAllowFailure('stop', `${base}.service`);
  fs.rmSync(paths.timer, { force: true });
  fs.rmSync(paths.service, { force: true });
  await systemctl('daemon-reload');
  await systemctlAllowFailure('reset-failed', `${base}.service`, `${base}.timer`);
}

export async function readScheduleStatus(schedule: BridgeSchedule): Promise<BridgeScheduleStatus> {
  const base = unitBase(schedule.id);
  const [timerOutput, serviceOutput] = await Promise.all([
    systemctlAllowFailure(
      'show', `${base}.timer`, '--no-pager',
      '--property=LoadState,ActiveState,SubState,NextElapseUSecRealtime,LastTriggerUSec',
    ),
    systemctlAllowFailure(
      'show', `${base}.service`, '--no-pager',
      '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp',
    ),
  ]);
  const timer = parseProperties(timerOutput);
  const service = parseProperties(serviceOutput);
  const running = service.ActiveState === 'activating' || service.ActiveState === 'active';
  // A newly activated timer reports LastTriggerUSec even before its service
  // has ever executed. The service start timestamp is the authoritative run
  // history and prevents a fresh schedule from showing a false success.
  const lastRun = timestampToIso(service.ExecMainStartTimestamp);

  return {
    ...schedule,
    unitName: base,
    timerActive: timer.ActiveState === 'active',
    running,
    nextRun: timestampToIso(timer.NextElapseUSecRealtime),
    lastRun,
    lastResult: running ? 'running' : lastRun ? (service.Result || 'unknown') : null,
  };
}

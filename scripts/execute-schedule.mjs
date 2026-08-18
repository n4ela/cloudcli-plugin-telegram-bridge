#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scheduleId = process.argv[2] || '';
if (!/^[a-f0-9]{12}$/.test(scheduleId)) {
  throw new Error('Usage: execute-schedule.mjs SCHEDULE_ID');
}

const configDirectory = process.env.CLOUDCLI_TELEGRAM_CONFIG_DIR
  || path.join(os.homedir(), '.cloudcli', 'telegram-bridge');
const config = JSON.parse(fs.readFileSync(path.join(configDirectory, 'config.json'), 'utf8'));
const schedule = config.schedules?.[scheduleId];
if (!schedule) throw new Error(`Schedule ${scheduleId} was not found`);

function run(command, args, options = {}) {
  process.stdout.write(`[cloudcli-schedule:${scheduleId}] ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${String(result.status)}`);
  }
}

if (Array.isArray(schedule.preCommand) && schedule.preCommand.length > 0) {
  run(schedule.preCommand[0], schedule.preCommand.slice(1), {
    cwd: schedule.workingDirectory || undefined,
  });
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const promptPath = path.join(configDirectory, 'schedules', `${scheduleId}.md`);
const helperPath = path.join(scriptDirectory, 'run-session.mjs');
const helperArguments = [
  helperPath,
  schedule.sessionId,
  promptPath,
  '--timeout-seconds=1800',
];
if (schedule.model) helperArguments.push(`--model=${schedule.model}`);
if (schedule.effort) helperArguments.push(`--effort=${schedule.effort}`);
run(process.execPath, helperArguments, {
  cwd: schedule.workingDirectory || undefined,
});

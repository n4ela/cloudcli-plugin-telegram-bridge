#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const packageDirectory = path.resolve(process.argv[2] || '');
const websocketUrl = process.argv[3] || '';
if (!packageDirectory || !websocketUrl) {
  throw new Error('Usage: configure-cloudcli.mjs CLOUDCLI_PACKAGE_DIR WS_URL');
}

const cloudcliRequire = createRequire(path.join(packageDirectory, 'package.json'));
const Database = cloudcliRequire('better-sqlite3');
const jwt = cloudcliRequire('jsonwebtoken');
const databasePath = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');
const database = new Database(databasePath, { readonly: true });
const secretRow = database.prepare('SELECT value FROM app_config WHERE key = ?').get('jwt_secret');
const user = database.prepare('SELECT id, username FROM users WHERE is_active = 1 ORDER BY id LIMIT 1').get();
database.close();

if (!secretRow?.value || !user?.id) {
  throw new Error('CloudCLI JWT secret or active user was not found');
}

const serviceToken = jwt.sign(
  { userId: user.id, username: user.username, service: 'telegram-bridge' },
  secretRow.value,
  { expiresIn: '10y' },
);

const configDirectory = process.env.CLOUDCLI_TELEGRAM_CONFIG_DIR
  || path.join(os.homedir(), '.cloudcli', 'telegram-bridge');
const configPath = path.join(configDirectory, 'config.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* first install */ }
config = {
  version: 1,
  botToken: '',
  bindings: {},
  pairCodes: {},
  ...config,
  cloudcliWsUrl: websocketUrl,
  cloudcliJwt: serviceToken,
};

fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
console.log(`Telegram Bridge service channel configured for ${websocketUrl}`);

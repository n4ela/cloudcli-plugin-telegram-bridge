# CloudCLI Telegram Bridge

Bidirectional Telegram access to an existing CloudCLI session, plus persistent
scheduled agent turns. The bridge uses the same provider run and the same
conversation: it does not start a second Codex process or maintain a separate
Telegram history.

## Features

- Bind one Telegram private chat, group, forum, or forum topic to one CloudCLI session.
- Mirror prompts and normalized live events between WebUI and Telegram.
- Keep model, reasoning effort, permission mode, queue, and provider-native history session-scoped.
- Deliver WebUI-originated prompts and their replies silently in Telegram.
- Run genuine scheduled Codex turns in the existing session through persistent systemd timers.
- English and Russian UI/bot messages. The plugin follows the CloudCLI language and falls back to English.
- Long polling: no public Telegram webhook or inbound port is required.

## Compatibility

The complete chat bridge requires the CloudCLI Omnichannel fork based on
CloudCLI `v1.37.1` or newer. Stock CloudCLI can load ordinary UI/server plugins,
but its public plugin context does not expose the chat interception and fan-out
hooks needed for a true WebUI ↔ Telegram shared session.

The split is intentional:

- this repository owns Telegram, pairing, localization, schedules, and plugin UI;
- the fork owns the small provider-independent session transport and persisted permission mode.

## Install

1. Open **Settings → Plugins** in the compatible CloudCLI fork.
2. Install this Git repository URL. CloudCLI clones it, installs dependencies,
   and runs `npm run build`.
3. Enable **Telegram Bridge** and restart the plugin if CloudCLI asks.
4. Configure the internal service connection once on the CloudCLI host:

   ```bash
   node scripts/configure-cloudcli.mjs \
     /path/to/cloudcli/package \
     ws://127.0.0.1:3001/ws
   ```

   `DATABASE_PATH` and `CLOUDCLI_TELEGRAM_CONFIG_DIR` can override the default
   `~/.cloudcli` paths. The generated service token and the Telegram token are
   stored locally in a mode-`600` configuration file.

5. In the plugin tab, save the BotFather token, open the desired CloudCLI
   session, and generate a six-digit pairing code.
6. Send `/bind CODE` in the desired Telegram chat or topic.

For a Telegram group or forum, disable BotFather privacy mode if the bot should
receive ordinary messages rather than commands only.

## Message behavior

- A Telegram prompt goes to the bound CloudCLI session and its reply sends a normal notification.
- A WebUI prompt is mirrored to Telegram as `You · WebUI`; that prompt and its reply are silent.
- Telegram-originated prompts are not echoed back to their own Telegram chat.
- If a session is busy, new prompts are queued in order.

The binding is persistent. Use `/mode`, `/mode safe`, `/mode project`, or
`/mode full` to read or change the same permission mode shown in WebUI.

## Schedules

The plugin tab creates daily schedules with a session, timezone, prompt, model,
and reasoning effort. Each schedule is backed by
`cloudcli-schedule-<id>.service` and `.timer`, with `Persistent=true`, so it
survives CloudCLI/plugin restarts and catches up after server downtime.

Schedules require Linux with systemd and permission to manage units in
`/etc/systemd/system` (the current deployment runs CloudCLI as root). The
scheduled prompt resumes the same provider-native thread, so later runs can
use earlier analysis from that session.

For manual automation, use:

```bash
node scripts/run-session.mjs SESSION_ID PROMPT_FILE \
  --model=gpt-5.6-sol --effort=max --timeout-seconds=1800
```

`scripts/notify-session.py` is also included for notification-only delivery
without starting a model turn.

## Development

```bash
npm ci
npm run typecheck
npm run build
```

`dist/` is generated and intentionally not committed. CloudCLI builds the
plugin during Git installation. Releases follow semantic versioning in both
`manifest.json` and `package.json`.

## Русский

Плагин привязывает Telegram-чат или тему к уже существующей сессии CloudCLI.
Сообщения, ответы, режим доступа и запуски по расписанию используют одну и ту
же историю Codex. Интерфейс автоматически переключается между русским и
английским вместе с языком CloudCLI; для остальных языков используется
английский. Установка и ограничения описаны выше.

## License

MIT


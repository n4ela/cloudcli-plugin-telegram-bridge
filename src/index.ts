import type { BridgeScheduleStatus, BridgeStatus, PluginAPI, PluginContext } from './types.js';
import { detectHostLocale, translate } from './i18n.js';

type RpcEnvelope<T> = T & { error?: string };

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function rpc<T>(api: PluginAPI, method: string, path: string, body?: unknown): Promise<T> {
  const result = await api.rpc(method, path, body) as RpcEnvelope<T>;
  if (result?.error) {
    throw new Error(result.error);
  }
  return result;
}

async function copyText(value: string, container: HTMLElement): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // HTTP deployments may not expose the modern Clipboard API, so use the legacy fallback below.
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  container.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  return copied;
}

function formatTimestamp(value: string | null, locale: string): string {
  if (!value) return translate(locale, 'ui.neverRun');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function scheduleResultLabel(schedule: BridgeScheduleStatus, locale: string): string {
  if (schedule.running) return translate(locale, 'ui.running');
  if (!schedule.lastResult) return translate(locale, 'ui.neverRun');
  if (schedule.lastResult === 'success') return translate(locale, 'ui.success');
  return translate(locale, 'ui.errorResult', { result: schedule.lastResult });
}

/** CloudCLI mounts this tab so the user can configure the bot and pair the currently open session. */
export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  root.style.cssText = 'height:100%;overflow:auto;padding:24px;box-sizing:border-box;font:14px ui-sans-serif,system-ui';
  container.appendChild(root);

  let context = api.context;
  let status: BridgeStatus | null = null;
  let notice = '';
  let error = '';
  let replacingToken = false;
  let pairCommand = '';
  let pairExpiresInSeconds = 0;
  let schedules: BridgeScheduleStatus[] = [];
  let scheduleFormOpen = false;

  const render = (): void => {
    const locale = detectHostLocale(context.language);
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => (
      translate(locale, key, values)
    );
    const dark = context.theme === 'dark';
    const colors = dark
      ? { bg: '#0b0d12', card: '#141821', text: '#f4f7fb', muted: '#929bad', border: '#293142', accent: '#2aabee', danger: '#ff8585' }
      : { bg: '#f7f9fc', card: '#fff', text: '#182033', muted: '#657087', border: '#dbe2ee', accent: '#168acd', danger: '#b42318' };
    root.style.background = colors.bg;
    root.style.color = colors.text;

    const session = context.session;
    const statusLine = status?.cloudcliConnected
      ? t('ui.cloudConnected')
      : status?.serviceConfigured
        ? t('ui.cloudReconnecting')
        : t('ui.serviceNotConfigured');
    const telegramLine = status?.telegramConnected
      ? t('ui.telegramConnected', { bot: status.botUsername ? ` · @${escapeHtml(status.botUsername)}` : '' })
      : status?.botConfigured
        ? t('ui.telegramReconnecting')
        : t('ui.addBotToken');
    const tokenIsSaved = Boolean(status?.botConfigured);
    const showSavedToken = tokenIsSaved && !replacingToken;
    const sessionTitle = session
      ? session.title.trim() && session.title.trim() !== session.id
        ? session.title.trim()
        : context.project?.name || t('ui.currentSession')
      : '';

    root.innerHTML = `
      <div style="max-width:820px;margin:0 auto">
        <h1 style="margin:0 0 8px;font-size:24px">Telegram Bridge</h1>
        <p style="margin:0 0 20px;color:${colors.muted}">${escapeHtml(t('ui.tagline'))}</p>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:16px">
          <div style="background:${colors.card};border:1px solid ${colors.border};border-radius:12px;padding:16px">
            <div style="font-weight:700;margin-bottom:6px">${status?.cloudcliConnected ? '🟢' : '🟡'} ${statusLine}</div>
            <div style="color:${colors.muted};font-size:12px">${escapeHtml(t('ui.sharedStream'))}</div>
          </div>
          <div style="background:${colors.card};border:1px solid ${colors.border};border-radius:12px;padding:16px">
            <div style="font-weight:700;margin-bottom:6px">${status?.telegramConnected ? '🟢' : '🟡'} ${telegramLine}</div>
            <div style="color:${colors.muted};font-size:12px">${escapeHtml(t('ui.longPolling'))}</div>
          </div>
        </div>

        <div style="background:${colors.card};border:1px solid ${colors.border};border-radius:12px;padding:18px;margin-bottom:16px">
          <h2 style="font-size:16px;margin:0 0 12px">${escapeHtml(t('ui.connectBot'))}</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="tg-token" type="password" autocomplete="new-password" ${showSavedToken ? 'readonly' : ''} value="${showSavedToken ? '••••••••••••••••' : ''}" placeholder="${escapeHtml(t('ui.tokenPlaceholder'))}" style="flex:1;min-width:260px;padding:10px 12px;border-radius:8px;border:1px solid ${colors.border};background:${colors.bg};color:${colors.text}" />
            <button id="${showSavedToken ? 'replace-token' : 'save-token'}" style="padding:10px 16px;border:0;border-radius:8px;background:${colors.accent};color:white;font-weight:700;cursor:pointer">${escapeHtml(showSavedToken ? t('ui.replaceToken') : t('ui.save'))}</button>
          </div>
          <p style="margin:10px 0 0;color:${tokenIsSaved ? colors.accent : colors.muted};font-size:12px">${escapeHtml(tokenIsSaved ? status?.botUsername ? t('ui.tokenSavedConnected', { bot: status.botUsername }) : t('ui.tokenSaved') : t('ui.tokenHelp'))}</p>
        </div>

        <div style="background:${colors.card};border:1px solid ${colors.border};border-radius:12px;padding:18px;margin-bottom:16px">
          <h2 style="font-size:16px;margin:0 0 8px">${escapeHtml(t('ui.bindSession'))}</h2>
          ${session ? `
            <div style="margin-bottom:12px"><strong>${escapeHtml(sessionTitle)}</strong><br><span style="color:${colors.muted};font-size:12px">ID: ${escapeHtml(session.id)}</span></div>
            <button id="create-code" style="padding:10px 16px;border:0;border-radius:8px;background:${colors.accent};color:white;font-weight:700;cursor:pointer">${escapeHtml(t('ui.createPairCode'))}</button>
            ${pairCommand ? `
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px;padding:10px;border:1px solid ${colors.border};border-radius:8px;background:${colors.bg}">
                <code style="flex:1;min-width:180px;font-size:15px;font-weight:700">${escapeHtml(pairCommand)}</code>
                <button id="copy-pair-command" style="padding:8px 12px;border:1px solid ${colors.border};border-radius:7px;background:${colors.card};color:${colors.text};font-weight:700;cursor:pointer">${escapeHtml(t('ui.copy'))}</button>
              </div>
              <div style="margin-top:6px;color:${colors.muted};font-size:12px">${escapeHtml(t('ui.codeValid', { minutes: Math.max(1, Math.round(pairExpiresInSeconds / 60)) }))}</div>
            ` : ''}
          ` : `<div style="color:${colors.muted}">${escapeHtml(t('ui.openSessionFirst'))}</div>`}
          <p style="margin:12px 0 0;color:${colors.muted};font-size:12px">${t('ui.bindHint')}</p>
        </div>

        <div style="background:${colors.card};border:1px solid ${colors.border};border-radius:12px;padding:18px">
          <h2 style="font-size:16px;margin:0 0 12px">${escapeHtml(t('ui.bindings'))}</h2>
          ${status?.bindings.length ? status.bindings.map((binding) => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid ${colors.border}">
              <div style="flex:1;min-width:0"><strong>${escapeHtml(binding.chatTitle)}</strong><br><span style="color:${colors.muted};font-size:12px">${escapeHtml(binding.sessionTitle)}</span></div>
              <button class="remove-binding" data-key="${escapeHtml(binding.key)}" style="border:1px solid ${colors.border};border-radius:7px;padding:7px 10px;background:transparent;color:${colors.danger};cursor:pointer">${escapeHtml(t('ui.disconnect'))}</button>
            </div>`).join('') : `<div style="color:${colors.muted}">${escapeHtml(t('ui.noBindings'))}</div>`}
        </div>

        <div style="background:${colors.card};border:1px solid ${colors.border};border-radius:12px;padding:18px;margin-top:16px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
            <div>
              <h2 style="font-size:16px;margin:0 0 4px">${escapeHtml(t('ui.schedules'))}</h2>
              <div style="color:${colors.muted};font-size:12px">${escapeHtml(t('ui.schedulesSubtitle'))}</div>
            </div>
            <button id="toggle-schedule-form" style="padding:9px 13px;border:0;border-radius:8px;background:${colors.accent};color:white;font-weight:700;cursor:pointer;white-space:nowrap">${escapeHtml(scheduleFormOpen ? t('ui.close') : t('ui.newTask'))}</button>
          </div>

          ${scheduleFormOpen ? `
            <div style="padding:14px;border:1px solid ${colors.border};border-radius:10px;background:${colors.bg};margin-bottom:14px">
              ${session ? `
                <div style="margin-bottom:12px;color:${colors.muted};font-size:12px">${escapeHtml(t('ui.session'))}: <strong style="color:${colors.text}">${escapeHtml(sessionTitle)}</strong></div>
                <div style="display:grid;grid-template-columns:minmax(0,1fr) 150px;gap:10px;margin-bottom:10px">
                  <label style="display:grid;gap:5px"><span style="font-size:12px;font-weight:700">${escapeHtml(t('ui.name'))}</span><input id="schedule-name" placeholder="${escapeHtml(t('ui.namePlaceholder'))}" style="padding:10px 12px;border-radius:8px;border:1px solid ${colors.border};background:${colors.card};color:${colors.text}" /></label>
                  <label style="display:grid;gap:5px"><span style="font-size:12px;font-weight:700">${escapeHtml(t('ui.time'))}</span><input id="schedule-time" type="time" value="08:00" style="padding:9px 12px;border-radius:8px;border:1px solid ${colors.border};background:${colors.card};color:${colors.text}" /></label>
                </div>
                <label style="display:grid;gap:5px;margin-bottom:10px"><span style="font-size:12px;font-weight:700">${escapeHtml(t('ui.taskPrompt'))}</span><textarea id="schedule-prompt" rows="6" placeholder="${escapeHtml(t('ui.taskPlaceholder'))}" style="resize:vertical;padding:10px 12px;border-radius:8px;border:1px solid ${colors.border};background:${colors.card};color:${colors.text};font:inherit"></textarea></label>
                <div style="display:grid;grid-template-columns:minmax(170px,1fr) 140px minmax(160px,1fr);gap:10px;margin-bottom:12px">
                  <label style="display:grid;gap:5px"><span style="font-size:12px;font-weight:700">${escapeHtml(t('ui.model'))}</span><input id="schedule-model" placeholder="${escapeHtml(t('ui.sessionSetting'))}" style="padding:10px 12px;border-radius:8px;border:1px solid ${colors.border};background:${colors.card};color:${colors.text}" /></label>
                  <label style="display:grid;gap:5px"><span style="font-size:12px;font-weight:700">${escapeHtml(t('ui.reasoning'))}</span><select id="schedule-effort" style="padding:10px 12px;border-radius:8px;border:1px solid ${colors.border};background:${colors.card};color:${colors.text}"><option value="" selected>${escapeHtml(t('ui.sessionSetting'))}</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option><option>ultra</option></select></label>
                  <label style="display:grid;gap:5px"><span style="font-size:12px;font-weight:700">${escapeHtml(t('ui.timezone'))}</span><input id="schedule-timezone" value="Europe/Moscow" style="padding:10px 12px;border-radius:8px;border:1px solid ${colors.border};background:${colors.card};color:${colors.text}" /></label>
                </div>
                <button id="create-schedule" style="padding:10px 16px;border:0;border-radius:8px;background:${colors.accent};color:white;font-weight:700;cursor:pointer">${escapeHtml(t('ui.createSchedule'))}</button>
              ` : `<div style="color:${colors.muted}">${escapeHtml(t('ui.openScheduleSession'))}</div>`}
            </div>
          ` : ''}

          ${schedules.length ? schedules.map((schedule) => {
            const resultColor = schedule.running || schedule.lastResult === 'success' ? colors.accent : schedule.lastResult ? colors.danger : colors.muted;
            return `
              <div style="padding:13px 0;border-top:1px solid ${colors.border}">
                <div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap">
                  <div style="flex:1;min-width:250px">
                    <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap"><strong>${escapeHtml(schedule.name)}</strong><span style="padding:2px 7px;border-radius:999px;background:${schedule.enabled ? colors.accent : colors.border};color:${schedule.enabled ? 'white' : colors.muted};font-size:11px">${escapeHtml(schedule.enabled ? t('ui.enabled') : t('ui.disabled'))}</span><span style="color:${resultColor};font-size:12px">${escapeHtml(scheduleResultLabel(schedule, locale))}</span></div>
                    <div style="margin-top:5px;color:${colors.muted};font-size:12px">${escapeHtml(schedule.sessionTitle)} · ${escapeHtml(t('ui.dailyAt', { time: schedule.time, timezone: schedule.timezone }))} · ${escapeHtml(schedule.model || t('ui.sessionSetting'))} / ${escapeHtml(schedule.effort || t('ui.sessionSetting'))}</div>
                    <div style="margin-top:4px;color:${colors.muted};font-size:12px">${escapeHtml(t('ui.next'))}: ${schedule.enabled ? escapeHtml(formatTimestamp(schedule.nextRun, locale)) : escapeHtml(t('ui.off'))} · ${escapeHtml(t('ui.last'))}: ${escapeHtml(formatTimestamp(schedule.lastRun, locale))}</div>
                    <details style="margin-top:7px"><summary style="cursor:pointer;color:${colors.muted};font-size:12px">${escapeHtml(t('ui.showTask'))}</summary><pre style="white-space:pre-wrap;margin:8px 0 0;padding:9px;border-radius:7px;background:${colors.bg};font:12px ui-monospace,SFMono-Regular,monospace">${escapeHtml(schedule.prompt)}</pre></details>
                  </div>
                  <div style="display:flex;gap:7px;flex-wrap:wrap">
                    <button class="run-schedule" data-id="${schedule.id}" style="border:1px solid ${colors.border};border-radius:7px;padding:7px 10px;background:transparent;color:${colors.text};cursor:pointer">${escapeHtml(t('ui.runNow'))}</button>
                    <button class="toggle-schedule" data-id="${schedule.id}" data-enabled="${String(!schedule.enabled)}" style="border:1px solid ${colors.border};border-radius:7px;padding:7px 10px;background:transparent;color:${colors.text};cursor:pointer">${escapeHtml(schedule.enabled ? t('ui.disable') : t('ui.enable'))}</button>
                    <button class="delete-schedule" data-id="${schedule.id}" data-name="${escapeHtml(schedule.name)}" style="border:1px solid ${colors.border};border-radius:7px;padding:7px 10px;background:transparent;color:${colors.danger};cursor:pointer">${escapeHtml(t('ui.delete'))}</button>
                  </div>
                </div>
              </div>`;
          }).join('') : `<div style="padding-top:8px;color:${colors.muted}">${escapeHtml(t('ui.noSchedules'))}</div>`}
        </div>

        ${notice ? `<div style="margin-top:14px;color:${colors.accent};font-weight:700">${escapeHtml(notice)}</div>` : ''}
        ${error || status?.lastError ? `<div style="margin-top:14px;color:${colors.danger}">${escapeHtml(error || status?.lastError || '')}</div>` : ''}
      </div>`;

    root.querySelector('#save-token')?.addEventListener('click', async () => {
      const input = root.querySelector<HTMLInputElement>('#tg-token');
      const token = input?.value.trim() ?? '';
      if (!token) return;
      error = '';
      notice = t('ui.checkingToken');
      render();
      try {
        const result = await rpc<{ username: string }>(api, 'POST', '/token', { token });
        notice = t('ui.botConnected', { bot: result.username });
        replacingToken = false;
        await refresh();
      } catch (caught) {
        notice = '';
        error = caught instanceof Error ? caught.message : String(caught);
        render();
      }
    });

    root.querySelector('#replace-token')?.addEventListener('click', () => {
      replacingToken = true;
      notice = '';
      error = '';
      render();
      root.querySelector<HTMLInputElement>('#tg-token')?.focus();
    });

    root.querySelector('#create-code')?.addEventListener('click', async () => {
      if (!context.session) return;
      error = '';
      try {
        const result = await rpc<{ code: string; expiresInSeconds: number }>(api, 'POST', '/pair', {
          sessionId: context.session.id,
          sessionTitle: context.session.title,
          locale,
        });
        pairCommand = `/bind ${result.code}`;
        pairExpiresInSeconds = result.expiresInSeconds;
        notice = '';
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      render();
    });

    root.querySelector('#copy-pair-command')?.addEventListener('click', async () => {
      const copied = await copyText(pairCommand, root);
      notice = copied ? t('ui.pairCopied') : '';
      error = copied ? '' : t('ui.copyFailed');
      render();
    });

    root.querySelectorAll<HTMLButtonElement>('.remove-binding').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await rpc(api, 'DELETE', `/bindings?key=${encodeURIComponent(button.dataset.key ?? '')}`);
          notice = t('ui.bindingRemoved');
          await refresh();
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          render();
        }
      });
    });

    root.querySelector('#toggle-schedule-form')?.addEventListener('click', () => {
      scheduleFormOpen = !scheduleFormOpen;
      notice = '';
      error = '';
      render();
    });

    root.querySelector('#create-schedule')?.addEventListener('click', async () => {
      if (!context.session) return;
      const name = root.querySelector<HTMLInputElement>('#schedule-name')?.value.trim() ?? '';
      const time = root.querySelector<HTMLInputElement>('#schedule-time')?.value.trim() ?? '';
      const prompt = root.querySelector<HTMLTextAreaElement>('#schedule-prompt')?.value.trim() ?? '';
      const model = root.querySelector<HTMLInputElement>('#schedule-model')?.value.trim() ?? '';
      const effort = root.querySelector<HTMLSelectElement>('#schedule-effort')?.value ?? '';
      const timezone = root.querySelector<HTMLInputElement>('#schedule-timezone')?.value.trim() ?? '';
      if (!name || !time || !prompt) {
        error = t('ui.fillSchedule');
        notice = '';
        render();
        return;
      }
      notice = t('ui.creatingSchedule');
      error = '';
      render();
      try {
        await rpc(api, 'POST', '/schedules', {
          name,
          time,
          prompt,
          model,
          effort,
          timezone,
          sessionId: context.session.id,
          sessionTitle,
        });
        scheduleFormOpen = false;
        notice = t('ui.scheduleCreated', { name });
        await refresh();
      } catch (caught) {
        notice = '';
        error = caught instanceof Error ? caught.message : String(caught);
        render();
      }
    });

    root.querySelectorAll<HTMLButtonElement>('.run-schedule').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await rpc(api, 'POST', `/schedules/${encodeURIComponent(button.dataset.id ?? '')}/run`);
          notice = t('ui.scheduleStarted');
          error = '';
          await refresh();
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          render();
        }
      });
    });

    root.querySelectorAll<HTMLButtonElement>('.toggle-schedule').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          const enabled = button.dataset.enabled === 'true';
          await rpc(api, 'PUT', `/schedules/${encodeURIComponent(button.dataset.id ?? '')}/enabled`, { enabled });
          notice = enabled ? t('ui.scheduleEnabled') : t('ui.scheduleDisabled');
          error = '';
          await refresh();
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          render();
        }
      });
    });

    root.querySelectorAll<HTMLButtonElement>('.delete-schedule').forEach((button) => {
      button.addEventListener('click', async () => {
        const name = button.dataset.name || t('ui.thisSchedule');
        if (!window.confirm(t('ui.deleteConfirm', { name }))) return;
        try {
          await rpc(api, 'DELETE', `/schedules/${encodeURIComponent(button.dataset.id ?? '')}`);
          notice = t('ui.scheduleDeleted');
          error = '';
          await refresh();
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
          render();
        }
      });
    });
  };

  const refresh = async (): Promise<void> => {
    try {
      const [nextStatus, scheduleResult] = await Promise.all([
        rpc<BridgeStatus>(api, 'GET', '/status'),
        rpc<{ schedules: BridgeScheduleStatus[] }>(api, 'GET', '/schedules'),
      ]);
      status = nextStatus;
      schedules = scheduleResult.schedules;
      if (
        status.cloudcliConnected
        && status.telegramConnected
        && notice === translate(detectHostLocale(context.language), 'ui.checkingToken')
      ) {
        notice = '';
      }
      error = '';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    render();
  };

  const unsubscribe = api.onContextChange((nextContext: PluginContext) => {
    if (nextContext.session?.id !== context.session?.id) {
      pairCommand = '';
      pairExpiresInSeconds = 0;
    }
    context = nextContext;
    render();
  });
  const timer = window.setInterval(() => {
    if (!scheduleFormOpen) void refresh();
  }, 5_000);
  (container as HTMLElement & { _telegramBridgeCleanup?: () => void })._telegramBridgeCleanup = () => {
    window.clearInterval(timer);
    unsubscribe();
  };
  void refresh();
}

export function unmount(container: HTMLElement): void {
  const managedContainer = container as HTMLElement & { _telegramBridgeCleanup?: () => void };
  managedContainer._telegramBridgeCleanup?.();
  delete managedContainer._telegramBridgeCleanup;
  container.innerHTML = '';
}

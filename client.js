/**
 * dsh-task-settle-notify - browser half.
 *
 * One card on the Plugins page (and in Settings) with the four switches the
 * Host half understands: master switch, batching window, only cards started by
 * a session, and include subtask summaries. It talks to the Host over the
 * same-origin JSON routes `lib/http.js` registers, needs only `slots` and
 * `locale`, and imports nothing from `@deepseek-ai/*` at runtime.
 *
 * No build step: the tree is written with `React.createElement`, styles are
 * inline tokens, and every failure (route missing, timeout, rejected save, a
 * late response after unmount) degrades to a muted note instead of throwing
 * into the host page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-settle-notify',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    /** Element constructor; keeps the tree readable without JSX. */
    const h = react.createElement;

    /** Locale namespace owned by this card. */
    const NS = 'taskSettleNotify';
    /** Entry id inside `plugins.item` and `settings.section`. */
    const CARD_ID = 'task-settle-notify';
    /** After the Atoll card (60), before the task board (110). */
    const CARD_ORDER = 61;
    /** Same-origin route prefix; fetched without the leading slash. */
    const API_PATH = 'api/task-settle-notify';
    /** Per-request ceiling; a stalled Host must not freeze the card. */
    const REQUEST_TIMEOUT_MS = 5000;

    const zh = {
      title: '任务结算通知',
      description: '任务看板的卡片结算后，自动通知发起它的会话；不用再盯着看板刷新。',
      summary: '卡片结算后自动通知发起会话。',
      loading: '正在读取设置…',
      unavailable: 'Host 路由尚未就绪，请重启 DSH 后再试。',
      loadFailed: '读取设置失败',
      retry: '重试',
      sectionBehavior: '通知行为',
      enabled: '启用结算通知',
      enabledHint: '关闭后看板照常运行，只是不再向会话投递消息。',
      batchWindow: '合批窗口',
      batchWindowHint: '窗口内结算的成功卡合并成一条；失败卡始终立即单发。',
      seconds: '秒',
      onlySelf: '只看会话发起的卡',
      onlySelfHint: '定时任务（cron）没有发起会话，不会被通知。',
      includeSubtasks: '父卡汇总子任务',
      includeSubtasksHint: '子任务不单独发消息，只在父卡结算时列一行摘要。',
      sectionStatus: '运行状态',
      state: '监听状态',
      active: '监听中',
      inactive: '未监听',
      pending: '待合批',
      delivered: '已投递',
      failed: '投递失败',
      suppressed: '已聚合子任务',
      lastDelivery: '最近投递',
      noDelivery: '还没有投递记录',
      lastError: '最近错误',
      settingsPath: '设置文件',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败',
      dirty: '有未保存的修改',
      unitCards: '张',
      notServed: '当前界面未提供此卡片。',
    };

    const en = {
      title: 'Task settlement notices',
      description: 'When a task-board card settles, tell the session that started it — no more polling the board.',
      summary: 'Notify the initiating session when a card settles.',
      loading: 'Reading settings…',
      unavailable: 'The Host routes are not ready yet. Restart DSH and try again.',
      loadFailed: 'Could not read settings',
      retry: 'Retry',
      sectionBehavior: 'Notification behavior',
      enabled: 'Enable settlement notices',
      enabledHint: 'Turning this off leaves the board running; it only stops the messages.',
      batchWindow: 'Batching window',
      batchWindowHint: 'Successful cards inside the window are merged; failures are always sent alone.',
      seconds: 's',
      onlySelf: 'Only session-started cards',
      onlySelfHint: 'Scheduled (cron) runs have no initiating session and are never notified.',
      includeSubtasks: 'Summarize subtasks on the parent',
      includeSubtasksHint: 'Children are not sent separately; the parent message lists them.',
      sectionStatus: 'Status',
      state: 'Listener',
      active: 'Listening',
      inactive: 'Not listening',
      pending: 'Pending',
      delivered: 'Delivered',
      failed: 'Failed',
      suppressed: 'Children folded',
      lastDelivery: 'Last delivery',
      noDelivery: 'Nothing delivered yet',
      lastError: 'Last error',
      settingsPath: 'Settings file',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'Save failed',
      dirty: 'Unsaved changes',
      unitCards: 'cards',
      notServed: 'This surface does not render the card.',
    };

    /**
     * Read a key without the locale service, used only if `props.t` is absent.
     * @param {string} key
     * @returns {string}
     */
    function fallbackTranslate(key) {
      const value = zh[key];
      return typeof value === 'string' ? value : key;
    }

    /** Fields this card edits. */
    const FIELDS = ['enabled', 'batchWindowSeconds', 'onlySelfInitiated', 'includeSubtasks'];

    /**
     * Accept only a well-shaped settings answer.
     * @param {unknown} raw
     * @returns {null | { enabled: boolean, batchWindowSeconds: number, onlySelfInitiated: boolean, includeSubtasks: boolean }}
     */
    function normalizeSettings(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const seconds = Number(raw.batchWindowSeconds);
      if (
        typeof raw.enabled !== 'boolean' ||
        typeof raw.onlySelfInitiated !== 'boolean' ||
        typeof raw.includeSubtasks !== 'boolean' ||
        !Number.isFinite(seconds)
      ) {
        return null;
      }
      return {
        enabled: raw.enabled,
        batchWindowSeconds: Math.min(600, Math.max(5, Math.round(seconds))),
        onlySelfInitiated: raw.onlySelfInitiated,
        includeSubtasks: raw.includeSubtasks,
      };
    }

    /**
     * Pull a short error code out of a Host answer.
     * @param {unknown} body
     * @returns {string}
     */
    function errorCode(body) {
      if (body && typeof body === 'object' && typeof body.error === 'string') return body.error.slice(0, 80);
      return '';
    }

    /**
     * One same-origin JSON request with a hard timeout.
     * @param {string} path
     * @param {{ method?: string, body?: string }} options
     * @param {number} timeoutMs
     * @returns {Promise<{ ok: boolean, status: number, body?: any, failed?: string }>}
     */
    async function request(path, options, timeoutMs) {
      if (typeof fetch !== 'function') return { ok: false, status: 0, failed: 'fetch-unavailable' };
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timer = controller
        ? setTimeout(() => {
            try {
              controller.abort();
            } catch {
              /* ignore */
            }
          }, timeoutMs)
        : undefined;
      try {
        const response = await fetch(path, {
          method: options.method ?? 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: options.body ? { 'content-type': 'application/json' } : undefined,
          body: options.body,
          signal: controller?.signal,
        });
        let body;
        try {
          body = await response.json();
        } catch {
          body = undefined;
        }
        return { ok: response.ok, status: response.status, body };
      } catch (error) {
        const failed = error && error.name === 'AbortError' ? 'timeout' : 'network';
        return { ok: false, status: 0, failed };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    /**
     * GET the effective settings.
     * @param {{ apiPath: string, timeoutMs: number }} face
     * @returns {Promise<{ kind: 'ok', settings: object } | { kind: 'unavailable' } | { kind: 'error', code: string }>}
     */
    async function readSettings(face) {
      const result = await request(`${face.apiPath}/settings`, {}, face.timeoutMs);
      if (result.failed) return { kind: 'error', code: result.failed };
      if (result.status === 404 || result.status === 405) return { kind: 'unavailable' };
      if (!result.ok) return { kind: 'error', code: errorCode(result.body) || `http-${result.status}` };
      if (!result.body || typeof result.body !== 'object' || result.body.ok === false) {
        return { kind: 'error', code: errorCode(result.body) || 'rejected' };
      }
      const settings = normalizeSettings(result.body.settings);
      return settings ? { kind: 'ok', settings } : { kind: 'error', code: 'invalid-response' };
    }

    /**
     * POST only the changed fields and adopt the Host's resolved answer.
     * @param {{ apiPath: string, timeoutMs: number }} face
     * @param {Record<string, unknown>} patch
     * @returns {Promise<{ kind: 'ok', settings: object } | { kind: 'unavailable' } | { kind: 'error', code: string }>}
     */
    async function writeSettings(face, patch) {
      const result = await request(
        `${face.apiPath}/settings`,
        { method: 'POST', body: JSON.stringify({ settings: patch }) },
        face.timeoutMs,
      );
      if (result.failed) return { kind: 'error', code: result.failed };
      if (result.status === 404 || result.status === 405) return { kind: 'unavailable' };
      if (!result.ok) return { kind: 'error', code: errorCode(result.body) || `http-${result.status}` };
      const settings = result.body && normalizeSettings(result.body.settings);
      return settings ? { kind: 'ok', settings } : { kind: 'error', code: 'invalid-response' };
    }

    /**
     * GET diagnostics; optional, an older Host only costs the card its status.
     * @param {{ apiPath: string, timeoutMs: number }} face
     * @returns {Promise<object | undefined>}
     */
    async function readStatus(face) {
      const result = await request(`${face.apiPath}/status`, {}, face.timeoutMs);
      if (result.failed || !result.ok) return undefined;
      const status = result.body && typeof result.body === 'object' ? result.body.status : undefined;
      return status && typeof status === 'object' ? status : undefined;
    }

    const FACE = {
      apiPath: API_PATH,
      timeoutMs: REQUEST_TIMEOUT_MS,
      readSettings,
      saveSettings: writeSettings,
      readStatus,
    };

    // ------------------------------------------------------------------ styles
    const COLOR_PRIMARY = 'var(--dsw-alias-label-primary, currentColor)';
    const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary, #4b5563)';
    const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #6b7280)';
    const COLOR_ERROR = 'var(--dsw-alias-label-error, #b42318)';
    const COLOR_SUCCESS = 'var(--dsw-alias-state-success-primary, #1a7f37)';
    const COLOR_BORDER = 'var(--dsw-alias-border-subtle, rgba(0, 0, 0, 0.1))';
    const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const STYLE_ROOT = { display: 'grid', gap: '14px', color: COLOR_PRIMARY, fontSize: '13px', lineHeight: 1.5 };
    const STYLE_DESCRIPTION = { margin: 0, color: COLOR_SECONDARY, fontSize: '13px' };
    const STYLE_SECTION = {
      margin: 0,
      color: COLOR_TERTIARY,
      fontSize: '11px',
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
    };
    const STYLE_ROW = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '8px 0',
      borderTop: `1px solid ${COLOR_BORDER}`,
    };
    const STYLE_LABEL = { display: 'grid', gap: '2px', minWidth: 0 };
    const STYLE_LABEL_TEXT = { fontWeight: 500 };
    const STYLE_HINT = { color: COLOR_TERTIARY, fontSize: '12px' };
    const STYLE_NOTE = { color: COLOR_TERTIARY, fontSize: '12px', margin: 0 };
    const STYLE_ERROR = { color: COLOR_ERROR, fontSize: '12px', margin: 0 };
    const STYLE_OK = { color: COLOR_SUCCESS, fontSize: '12px', margin: 0 };
    const STYLE_INPUT = {
      width: '72px',
      boxSizing: 'border-box',
      padding: '4px 6px',
      borderRadius: '6px',
      border: `1px solid ${COLOR_BORDER}`,
      background: 'transparent',
      color: COLOR_PRIMARY,
      fontSize: '13px',
    };
    const STYLE_BUTTON = {
      justifySelf: 'start',
      padding: '5px 14px',
      borderRadius: '6px',
      border: `1px solid ${COLOR_BORDER}`,
      background: 'transparent',
      color: COLOR_PRIMARY,
      fontSize: '13px',
      cursor: 'pointer',
    };
    const STYLE_STATUS = {
      display: 'grid',
      gap: '3px',
      padding: '8px 10px',
      borderRadius: '6px',
      background: 'color-mix(in srgb, currentColor 4%, transparent)',
      color: COLOR_SECONDARY,
      fontSize: '12px',
    };
    const STYLE_CODE = { fontFamily: FONT_MONO, fontSize: '11px', wordBreak: 'break-all' };

    /**
     * One labeled row with a control on the right.
     * @param {{ label: string, hint?: string, control: any, key?: string }} props
     */
    function Row(props) {
      return h(
        'div',
        { style: STYLE_ROW },
        h(
          'div',
          { style: STYLE_LABEL },
          h('span', { style: STYLE_LABEL_TEXT }, props.label),
          props.hint ? h('span', { style: STYLE_HINT }, props.hint) : null,
        ),
        props.control,
      );
    }

    /**
     * A native checkbox; native controls keep keyboard and screen-reader
     * behavior without re-implementing it.
     * @param {{ checked: boolean, disabled?: boolean, label: string, onChange: (value: boolean) => void }} props
     */
    function Toggle(props) {
      return h('input', {
        type: 'checkbox',
        checked: props.checked,
        disabled: props.disabled,
        'aria-label': props.label,
        style: { width: '16px', height: '16px', marginTop: '2px', cursor: 'pointer' },
        onChange: (event) => props.onChange(Boolean(event.target.checked)),
      });
    }

    /**
     * The settings card.
     * @param {{ view?: 'summary' | 'page', t?: (key: string) => string, taskSettleNotify?: any }} props
     */
    function TaskSettleNotifyCard(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const injected = props.taskSettleNotify && typeof props.taskSettleNotify === 'object'
        ? props.taskSettleNotify
        : FACE;
      const face = {
        apiPath: typeof injected.apiPath === 'string' ? injected.apiPath : API_PATH,
        timeoutMs: Number.isFinite(injected.timeoutMs) ? injected.timeoutMs : REQUEST_TIMEOUT_MS,
        readSettings: typeof injected.readSettings === 'function' ? injected.readSettings : readSettings,
        saveSettings: typeof injected.saveSettings === 'function' ? injected.saveSettings : writeSettings,
        readStatus: typeof injected.readStatus === 'function' ? injected.readStatus : readStatus,
      };

      const [phase, setPhase] = react.useState('loading');
      const [settings, setSettings] = react.useState(null);
      const [draft, setDraft] = react.useState(null);
      const [status, setStatus] = react.useState(undefined);
      const [error, setError] = react.useState('');
      const [saving, setSaving] = react.useState(false);
      const [savedAt, setSavedAt] = react.useState(0);
      const alive = react.useRef(true);

      react.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = react.useCallback(async () => {
        setPhase('loading');
        setError('');
        const [settingsResult, statusResult] = await Promise.all([
          face.readSettings(face),
          face.readStatus(face).catch(() => undefined),
        ]);
        if (!alive.current) return;
        setStatus(statusResult);
        if (settingsResult.kind === 'ok') {
          setSettings(settingsResult.settings);
          setDraft(settingsResult.settings);
          setPhase('ready');
          return;
        }
        setPhase(settingsResult.kind === 'unavailable' ? 'unavailable' : 'failed');
        setError(settingsResult.kind === 'error' ? settingsResult.code : '');
      }, [face.apiPath, face.timeoutMs]);

      react.useEffect(() => {
        void load();
      }, [load]);

      if (props.view === 'summary') return t('summary');

      const dirty =
        settings !== null &&
        draft !== null &&
        FIELDS.some((field) => draft[field] !== settings[field]);

      /** @param {string} field @param {unknown} value */
      const change = (field, value) => {
        setDraft((current) => (current ? { ...current, [field]: value } : current));
        setSavedAt(0);
      };

      const save = async () => {
        if (!draft || saving) return;
        const patch = {};
        for (const field of FIELDS) {
          if (draft[field] !== settings[field]) patch[field] = draft[field];
        }
        if (Object.keys(patch).length === 0) return;
        setSaving(true);
        setError('');
        const result = await face.saveSettings(face, patch);
        if (!alive.current) return;
        setSaving(false);
        if (result.kind === 'ok') {
          setSettings(result.settings);
          setDraft(result.settings);
          setSavedAt(Date.now());
          setStatus(await face.readStatus(face).catch(() => undefined));
          return;
        }
        setError(result.kind === 'unavailable' ? t('unavailable') : `${t('saveFailed')}：${result.code}`);
      };

      if (phase === 'loading') return h('p', { style: STYLE_NOTE }, t('loading'));
      if (phase === 'unavailable') return h('p', { style: STYLE_NOTE }, t('unavailable'));
      if (phase === 'failed' || !draft) {
        return h(
          'div',
          { style: STYLE_ROOT },
          h('p', { style: STYLE_ERROR }, error ? `${t('loadFailed')}：${error}` : t('loadFailed')),
          h('button', { type: 'button', style: STYLE_BUTTON, onClick: () => void load() }, t('retry')),
        );
      }

      const seconds = Number(draft.batchWindowSeconds);
      return h(
        'div',
        { style: STYLE_ROOT },
        h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          h('h3', { style: { margin: 0, fontSize: '15px', fontWeight: 600 } }, t('title')),
          h('p', { style: STYLE_DESCRIPTION }, t('description')),
        ),
        h('p', { style: STYLE_SECTION }, t('sectionBehavior')),
        h(Row, {
          label: t('enabled'),
          hint: t('enabledHint'),
          control: h(Toggle, {
            checked: draft.enabled,
            disabled: saving,
            label: t('enabled'),
            onChange: (value) => change('enabled', value),
          }),
        }),
        h(Row, {
          label: t('batchWindow'),
          hint: t('batchWindowHint'),
          control: h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('input', {
              type: 'number',
              min: 5,
              max: 600,
              step: 1,
              value: Number.isFinite(seconds) ? seconds : 30,
              disabled: saving,
              'aria-label': t('batchWindow'),
              style: STYLE_INPUT,
              onChange: (event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next)) change('batchWindowSeconds', Math.min(600, Math.max(5, Math.round(next))));
              },
            }),
            h('span', { style: STYLE_HINT }, t('seconds')),
          ),
        }),
        h(Row, {
          label: t('onlySelf'),
          hint: t('onlySelfHint'),
          control: h(Toggle, {
            checked: draft.onlySelfInitiated,
            disabled: saving,
            label: t('onlySelf'),
            onChange: (value) => change('onlySelfInitiated', value),
          }),
        }),
        h(Row, {
          label: t('includeSubtasks'),
          hint: t('includeSubtasksHint'),
          control: h(Toggle, {
            checked: draft.includeSubtasks,
            disabled: saving,
            label: t('includeSubtasks'),
            onChange: (value) => change('includeSubtasks', value),
          }),
        }),
        h('p', { style: STYLE_SECTION }, t('sectionStatus')),
        h(
          'div',
          { style: STYLE_STATUS },
          h('span', null, `${t('state')}：${status && status.extensionActive ? t('active') : t('inactive')}`),
          h(
            'span',
            null,
            `${t('pending')}：${status && Number.isFinite(status.pending) ? status.pending : 0} ${t('unitCards')} · ` +
              `${t('delivered')}：${status && Number.isFinite(status.delivered) ? status.delivered : 0} · ` +
              `${t('failed')}：${status && Number.isFinite(status.failed) ? status.failed : 0}`,
          ),
          h(
            'span',
            null,
            `${t('lastDelivery')}：${
              status && status.lastDelivery && status.lastDelivery.preview
                ? String(status.lastDelivery.preview).slice(0, 120)
                : t('noDelivery')
            }`,
          ),
          status && status.lastError
            ? h('span', { style: STYLE_ERROR }, `${t('lastError')}：${String(status.lastError).slice(0, 160)}`)
            : null,
          status && status.settingsPath
            ? h('span', { style: STYLE_CODE }, `${t('settingsPath')}：${status.settingsPath}`)
            : null,
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h(
            'button',
            { type: 'button', style: STYLE_BUTTON, disabled: !dirty || saving, onClick: () => void save() },
            saving ? t('saving') : t('save'),
          ),
          savedAt && !dirty ? h('span', { style: STYLE_OK }, t('saved')) : null,
          dirty && !saving ? h('span', { style: STYLE_HINT }, t('dirty')) : null,
          error ? h('span', { style: STYLE_ERROR }, error) : null,
        ),
      );
    }

    /** Required services (cordis fiber inject). */
    const inject = ['slots', 'locale'];

    /** @param {string} where @param {unknown} error */
    function warn(where, error) {
      try {
        console.warn(`[dsh-task-settle-notify] ${where} failed`, error);
      } catch {
        /* ignore */
      }
    }

    /**
     * Mount the browser half.
     * @param {any} ctx browser plugin context
     */
    function apply(ctx) {
      try {
        const t = ctx.locale.bind(NS);
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'task-settle-notify: dictionaries');
        } catch (error) {
          warn('dictionary registration', error);
        }
        const entry = {
          id: CARD_ID,
          order: CARD_ORDER,
          label: () => t('title'),
          locale: NS,
          inject: () => ({ taskSettleNotify: FACE }),
        };
        for (const slot of ['plugins.item', 'settings.section']) {
          try {
            ctx.effect(
              () =>
                ctx.slots.inject(slot, () =>
                  ctx.slots.register({ ...entry, name: slot }, TaskSettleNotifyCard),
                ),
              `task-settle-notify: ${slot}`,
            );
          } catch (error) {
            warn(`${slot} registration`, error);
          }
        }
      } catch (error) {
        warn('apply', error);
      }
    }

    exports.NS = NS;
    exports.TaskSettleNotifyCard = TaskSettleNotifyCard;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

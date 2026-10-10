// Locatra – options.js
// The settings page (options_ui). Everything saves the moment it changes and is
// announced in the header's live region. Other pages (side panel, content scripts,
// worker) follow chrome.storage.onChanged, and so does this page.
//
// Storage (chrome.storage.local):
//   llSettings   { autoAssertions, stepScreenshots, testIdAttributes, secretNames,
//                  variables, healthAutoCheck } — a missing key/field means its default
//   llFramework / llLanguage   output target (shared with the side panel)
//   customAttributes           legacy test-id list: migrated into
//                              llSettings.testIdAttributes on first load, then removed
//   llRecorderState[:<window>] recorder timelines · llWatched watched locators
//
// Nothing read from storage or an imported file reaches innerHTML: every value is
// rendered through textContent / DOM APIs.

(function () {
  'use strict';

  const SETTINGS_KEY = 'llSettings';
  const LEGACY_ATTRS_KEY = 'customAttributes';
  const FW_KEY = 'llFramework';
  const LANG_KEY = 'llLanguage';
  const WATCHED_KEY = 'llWatched';
  const RECORDER_KEY_RE = /^llRecorderState(:|$)/;

  // Mirrors content.js BUILTIN_TEST_ATTRIBUTES (what the engine falls back to).
  const BUILTIN_TEST_ATTRIBUTES = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'data-automation-id', 'data-e2e'];
  const ATTR_NAME_RE = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
  const OWN_ATTR_RE = /^data-(ll|locatra)-/i;
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const MAX_ATTRS = 20;
  const MAX_ATTR_LEN = 100;
  const MAX_IDENT_LEN = 64;
  const DEFAULT_SECRET_NAMES = { password: 'LOCATRA_PASSWORD', secret: 'LOCATRA_SECRET' };
  const DEFAULT_FRAMEWORK = 'playwright';
  const DEFAULT_LANGUAGE = 'typescript';
  const BOOL_KEYS = ['autoAssertions', 'stepScreenshots', 'variables', 'healthAutoCheck'];
  const KNOWN_KEYS = BOOL_KEYS.concat(['testIdAttributes', 'secretNames']);
  const SHOT_ORIGINS = ['<all_urls>'];
  const EXPORT_FORMAT = 'locatra-settings';
  const EXPORT_VERSION = 1;
  const IMPORT_MAX_BYTES = 256 * 1024;
  const STATUS_MS = 3000;
  const SECRET_SAVE_DELAY_MS = 400;
  const FALLBACK_FRAMEWORKS = [
    { id: 'playwright', label: 'Playwright' },
    { id: 'selenium', label: 'Selenium' },
    { id: 'cypress', label: 'Cypress' }
  ];
  const FALLBACK_LANGUAGES = [
    { id: 'typescript', label: 'TypeScript' },
    { id: 'javascript', label: 'JavaScript' },
    { id: 'python', label: 'Python' }
  ];
  const SAMPLE_TARGET = { kind: 'testid', attr: 'data-testid', value: 'sign-in' };
  const COMMAND_LABELS = {
    _execute_action: 'Open the Locatra popup',
    _execute_browser_action: 'Open the Locatra popup',
    _execute_sidebar_action: 'Open or close the Locatra sidebar'
  };

  const api = typeof chrome !== 'undefined' ? chrome : null;

  let settings = defaultSettings();
  let extras = {}; // llSettings fields this version does not know: kept on save
  let framework = DEFAULT_FRAMEWORK;
  let language = DEFAULT_LANGUAGE;
  let screenshotPermission = null; // true / false / null (unknown)
  let screenshotDeclined = false;
  let statusTimer = null;
  const secretTimers = {};

  // ── Small helpers ──────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function lastErrorMessage() {
    try {
      const e = api && api.runtime && api.runtime.lastError;
      return e ? (e.message || String(e)) : null;
    } catch (err) {
      return String(err);
    }
  }

  /** A value for an error message: quoted, clipped, never markup (rendered as text). */
  function shown(v) {
    let s;
    try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (err) { s = String(v); }
    s = String(s);
    if (s.length > 40) s = s.slice(0, 39) + '…';
    return '“' + s + '”';
  }

  function storage() { return api && api.storage && api.storage.local ? api.storage.local : null; }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      const s = storage();
      if (!s) { resolve({}); return; }
      s.get(keys, (res) => {
        const err = lastErrorMessage();
        if (err) reject(new Error(err));
        else resolve(res || {});
      });
    });
  }

  function storageSet(obj) {
    return new Promise((resolve, reject) => {
      const s = storage();
      if (!s) { reject(new Error('storage is unavailable')); return; }
      s.set(obj, () => {
        const err = lastErrorMessage();
        if (err) reject(new Error(err));
        else resolve();
      });
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      const s = storage();
      if (!s) { reject(new Error('storage is unavailable')); return; }
      s.remove(keys, () => {
        const err = lastErrorMessage();
        if (err) reject(new Error(err));
        else resolve();
      });
    });
  }

  function showStatus(text, tone) {
    const el = $('saveStatus');
    if (!el) return;
    el.dataset.tone = tone || 'ok';
    el.textContent = text;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ''; }, STATUS_MS);
  }

  function showError(prefix, err) {
    showStatus(prefix + ((err && err.message) ? ': ' + err.message : ''), 'error');
  }

  // ── Settings model ─────────────────────────────────────────────────────────
  function defaultSettings() {
    return {
      autoAssertions: true,
      stepScreenshots: true,
      testIdAttributes: [],
      secretNames: Object.assign({}, DEFAULT_SECRET_NAMES),
      variables: true,
      healthAutoCheck: false
    };
  }

  /** Why `name` cannot be a test-id attribute (null when it can). */
  function attrNameError(name) {
    if (typeof name !== 'string' || !name) return 'Enter an attribute name.';
    if (name.length > MAX_ATTR_LEN) return `Attribute names can be at most ${MAX_ATTR_LEN} characters.`;
    if (!ATTR_NAME_RE.test(name)) return `${shown(name)} is not a valid attribute name. Use letters, digits, “-”, “_”, “:” or “.”, starting with a letter.`;
    if (OWN_ATTR_RE.test(name)) return 'Locatra’s own data-ll-* / data-locatra-* attributes cannot be used.';
    return null;
  }

  /** Valid, distinct (case-insensitively), lower-cased names; at most MAX_ATTRS. */
  function cleanAttrs(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim().toLowerCase();
      if (attrNameError(name) || out.indexOf(name) !== -1) continue;
      out.push(name);
      if (out.length >= MAX_ATTRS) break;
    }
    return out;
  }

  function identError(v) {
    if (typeof v !== 'string' || !v) return 'Enter a variable name.';
    if (v.length > MAX_IDENT_LEN) return `At most ${MAX_IDENT_LEN} characters.`;
    if (!IDENT_RE.test(v)) return 'Use letters, digits and “_”, not starting with a digit.';
    return null;
  }

  function normalizeSettings(raw) {
    const s = isPlainObject(raw) ? raw : {};
    const names = isPlainObject(s.secretNames) ? s.secretNames : {};
    const ident = (k) => (identError(names[k]) ? DEFAULT_SECRET_NAMES[k] : names[k]);
    return {
      autoAssertions: s.autoAssertions !== false,
      stepScreenshots: s.stepScreenshots !== false,
      testIdAttributes: cleanAttrs(s.testIdAttributes),
      secretNames: { password: ident('password'), secret: ident('secret') },
      variables: s.variables !== false,
      healthAutoCheck: s.healthAutoCheck === true
    };
  }

  /** Fields of a stored llSettings this page does not manage (kept as they are). */
  function extrasOf(raw) {
    const out = {};
    if (!isPlainObject(raw)) return out;
    Object.keys(raw).forEach((k) => {
      if (KNOWN_KEYS.indexOf(k) !== -1 || k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      out[k] = raw[k];
    });
    return out;
  }

  function settingsForStorage() {
    const out = {};
    Object.keys(extras).forEach((k) => { out[k] = extras[k]; });
    out.autoAssertions = settings.autoAssertions;
    out.stepScreenshots = settings.stepScreenshots;
    out.testIdAttributes = settings.testIdAttributes.slice();
    out.secretNames = { password: settings.secretNames.password, secret: settings.secretNames.secret };
    out.variables = settings.variables;
    out.healthAutoCheck = settings.healthAutoCheck;
    return out;
  }

  function persistSettings(message) {
    return storageSet({ [SETTINGS_KEY]: settingsForStorage() }).then(
      () => showStatus(message || 'Saved'),
      (err) => showError('Could not save', err)
    );
  }

  // ── Frameworks / languages ─────────────────────────────────────────────────
  function codegen() { return typeof window !== 'undefined' && window.LLCodegen ? window.LLCodegen : null; }

  function frameworkList() {
    const C = codegen();
    return C && Array.isArray(C.FRAMEWORKS) && C.FRAMEWORKS.length ? C.FRAMEWORKS : FALLBACK_FRAMEWORKS;
  }

  function languageList(fw) {
    const C = codegen();
    if (C && typeof C.languagesFor === 'function') return C.languagesFor(fw);
    if (!frameworkList().some((f) => f.id === fw)) return [];
    return FALLBACK_LANGUAGES.filter((l) => !(fw === 'cypress' && l.id === 'python'));
  }

  /** A valid framework + language pair, as close to the requested one as possible. */
  function resolveOutput(fw, lang) {
    const fws = frameworkList();
    const f = fws.some((x) => x.id === fw) ? fw : (fws.some((x) => x.id === DEFAULT_FRAMEWORK) ? DEFAULT_FRAMEWORK : fws[0].id);
    const langs = languageList(f);
    let l = langs.some((x) => x.id === lang) ? lang : null;
    if (!l) l = langs.some((x) => x.id === DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : (langs[0] ? langs[0].id : DEFAULT_LANGUAGE);
    return { framework: f, language: l };
  }

  // ── Rendering: Locators ────────────────────────────────────────────────────
  function iconButton(action, label, text, onClick, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-icon';
    b.textContent = text;
    b.dataset.action = action;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.disabled = !!disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Rebuilds the editor, the built-in list and the priority preview. `focus`
   * ({ index, action } or { input: true }) keeps keyboard focus on a sensible
   * control after the rebuild.
   */
  function renderAttrs(focus) {
    const list = $('testAttrList');
    const attrs = settings.testIdAttributes;
    list.textContent = '';
    attrs.forEach((name, i) => {
      const li = document.createElement('li');
      li.className = 'attr-row';
      const code = document.createElement('code');
      code.className = 'attr-name';
      code.textContent = name;
      li.appendChild(code);
      li.appendChild(iconButton('up', `Move ${name} up`, '↑', () => moveAttr(i, -1), i === 0));
      li.appendChild(iconButton('down', `Move ${name} down`, '↓', () => moveAttr(i, 1), i === attrs.length - 1));
      li.appendChild(iconButton('remove', `Remove ${name}`, '✕', () => removeAttr(i)));
      list.appendChild(li);
    });
    list.hidden = !attrs.length;
    $('testAttrEmpty').hidden = attrs.length > 0;
    const full = attrs.length >= MAX_ATTRS;
    $('testAttrAddBtn').disabled = full;
    $('testAttrInput').disabled = full;
    $('testAttrHelp').textContent = full
      ? `The list is full (${MAX_ATTRS} attributes). Remove one to add another.`
      : `An HTML attribute name, e.g. data-qa-id. ${attrs.length} of ${MAX_ATTRS} used.`;

    const builtins = $('builtinAttrList');
    builtins.textContent = '';
    BUILTIN_TEST_ATTRIBUTES.forEach((name) => {
      const li = document.createElement('li');
      li.className = 'chip mono';
      li.textContent = name;
      builtins.appendChild(li);
    });

    const priority = $('attrPriority');
    priority.textContent = '';
    const seen = new Set();
    attrs.concat(BUILTIN_TEST_ATTRIBUTES).forEach((name) => {
      if (seen.has(name)) return;
      seen.add(name);
      const li = document.createElement('li');
      if (attrs.indexOf(name) !== -1) li.className = 'custom';
      const code = document.createElement('code');
      code.textContent = name;
      li.appendChild(code);
      priority.appendChild(li);
    });

    if (focus) focusAttrControl(focus);
  }

  /** Where keyboard focus is inside the attribute list (to restore after a rebuild), or null. */
  function attrFocusSnapshot() {
    const a = document.activeElement;
    const list = $('testAttrList');
    if (!a || !list.contains(a) || !a.dataset.action) return null;
    return { index: Array.prototype.indexOf.call(list.children, a.closest('li')), action: a.dataset.action };
  }

  function focusAttrControl(focus) {
    const rows = $('testAttrList').children;
    const input = $('testAttrInput');
    if (focus.index != null && rows.length) {
      const row = rows[Math.min(focus.index, rows.length - 1)];
      let target = row.querySelector(`[data-action="${focus.action}"]`);
      if (!target || target.disabled) target = row.querySelector('[data-action="remove"]');
      target.focus();
    } else if (!input.disabled) {
      input.focus();
    }
  }

  function setAttrError(msg) {
    $('testAttrError').textContent = msg || '';
    $('testAttrInput').setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  function addAttr() {
    const input = $('testAttrInput');
    const name = input.value.trim().toLowerCase();
    const err = attrNameError(name) ||
      (settings.testIdAttributes.indexOf(name) !== -1 ? `${shown(name)} is already in your list.` : null) ||
      (settings.testIdAttributes.length >= MAX_ATTRS ? `You can add up to ${MAX_ATTRS} attributes.` : null);
    if (err) {
      setAttrError(err);
      input.focus();
      return;
    }
    setAttrError('');
    settings.testIdAttributes = settings.testIdAttributes.concat([name]);
    input.value = '';
    const last = settings.testIdAttributes.length - 1;
    // A full list disables the input: focus moves to the attribute just added.
    renderAttrs(last + 1 >= MAX_ATTRS ? { index: last, action: 'remove' } : { input: true });
    persistSettings(`Added ${name}`);
  }

  function moveAttr(i, delta) {
    const list = settings.testIdAttributes.slice();
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    settings.testIdAttributes = list;
    renderAttrs({ index: j, action: delta < 0 ? 'up' : 'down' });
    persistSettings(`Moved ${tmp} ${delta < 0 ? 'up' : 'down'}`);
  }

  function removeAttr(i) {
    const name = settings.testIdAttributes[i];
    settings.testIdAttributes = settings.testIdAttributes.filter((_, k) => k !== i);
    renderAttrs({ index: settings.testIdAttributes.length ? i : null, action: 'remove' });
    persistSettings(`Removed ${name}`);
  }

  // ── Rendering: Output ──────────────────────────────────────────────────────
  function fillSelect(select, items, value) {
    select.textContent = '';
    items.forEach((item) => {
      const o = document.createElement('option');
      o.value = item.id;
      o.textContent = item.label || item.id;
      select.appendChild(o);
    });
    select.value = value;
  }

  function renderOutput() {
    fillSelect($('outFramework'), frameworkList(), framework);
    fillSelect($('outLanguage'), languageList(framework), language);
    const C = codegen();
    let sample = '';
    let ext = '';
    try {
      sample = C ? C.locatorExpr(SAMPLE_TARGET, framework, language) || '' : '';
      ext = C && typeof C.fileExtension === 'function' ? C.fileExtension(language) : '';
    } catch (err) {
      sample = '';
    }
    $('outPreview').textContent = sample || '—';
    $('outExt').textContent = ext ? `${ext} files` : 'generated code';
  }

  function onFrameworkChange() {
    const next = resolveOutput($('outFramework').value, language);
    framework = next.framework;
    language = next.language;
    renderOutput();
    saveOutput();
  }

  function onLanguageChange() {
    const next = resolveOutput(framework, $('outLanguage').value);
    language = next.language;
    renderOutput();
    saveOutput();
  }

  function outputLabel() {
    const f = frameworkList().find((x) => x.id === framework);
    const l = languageList(framework).find((x) => x.id === language);
    return `${f ? f.label : framework} · ${l ? l.label : language}`;
  }

  function saveOutput() {
    return storageSet({ [FW_KEY]: framework, [LANG_KEY]: language }).then(
      () => showStatus(`Saved — ${outputLabel()}`),
      (err) => showError('Could not save', err)
    );
  }

  // ── Rendering: Recorder + health toggles ───────────────────────────────────
  const TOGGLES = {
    setAutoAssertions: 'autoAssertions',
    setStepScreenshots: 'stepScreenshots',
    setVariables: 'variables',
    setHealthAutoCheck: 'healthAutoCheck'
  };

  function renderToggles() {
    Object.keys(TOGGLES).forEach((id) => { $(id).checked = !!settings[TOGGLES[id]]; });
    updateScreenshotNotice();
  }

  function onToggle(e) {
    const id = e.target.id;
    const key = TOGGLES[id];
    settings[key] = !!e.target.checked;
    // The permission prompt needs this user gesture: ask before anything async.
    if (key === 'stepScreenshots' && settings.stepScreenshots && screenshotPermission !== true) requestScreenshotPermission();
    updateScreenshotNotice();
    persistSettings();
  }

  // ── Screenshot permission (same flow as the side panel) ────────────────────
  function permissionsApi() {
    return api && api.permissions && typeof api.permissions.contains === 'function' ? api.permissions : null;
  }

  function checkScreenshotPermission() {
    const p = permissionsApi();
    if (!p) { updateScreenshotNotice(); return; }
    try {
      p.contains({ origins: SHOT_ORIGINS }, (granted) => {
        void lastErrorMessage();
        if (typeof granted === 'boolean') {
          screenshotPermission = granted;
          if (granted) screenshotDeclined = false;
        }
        updateScreenshotNotice();
      });
    } catch (err) {
      updateScreenshotNotice();
    }
  }

  /** Must run synchronously inside a click/change handler — browsers prompt only for a user gesture. */
  function requestScreenshotPermission() {
    const p = api && api.permissions && typeof api.permissions.request === 'function' ? api.permissions : null;
    if (!p) return;
    let settled = false;
    const after = (granted) => {
      if (settled) return;
      settled = true;
      void lastErrorMessage();
      screenshotDeclined = granted !== true;
      if (granted === true) screenshotPermission = true;
      if (granted === true) showStatus('Screenshot access granted');
      checkScreenshotPermission();
    };
    try {
      const r = p.request({ origins: SHOT_ORIGINS }, after);
      // Promise-style implementations (Firefox's) may ignore the callback.
      if (r && typeof r.then === 'function') r.then(after, () => after(false));
    } catch (err) {
      after(false);
    }
  }

  function updateScreenshotNotice() {
    const need = settings.stepScreenshots && screenshotPermission === false;
    $('shotPermNotice').hidden = !need;
    $('shotPermDeclined').hidden = !(need && screenshotDeclined);
  }

  // ── Rendering: secret variable names ───────────────────────────────────────
  const SECRET_FIELDS = { secretPassword: 'password', secretSecret: 'secret' };

  function renderSecrets() {
    Object.keys(SECRET_FIELDS).forEach((id) => {
      const input = $(id);
      // Never overwrite what the user is in the middle of typing.
      if (document.activeElement === input && input.getAttribute('aria-invalid') === 'true') return;
      input.value = settings.secretNames[SECRET_FIELDS[id]];
      setSecretError(id, '');
    });
  }

  function setSecretError(id, msg) {
    $(id + 'Error').textContent = msg || '';
    $(id).setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  function secretFieldError(id) {
    const key = SECRET_FIELDS[id];
    const value = $(id).value.trim();
    const err = identError(value);
    if (err) return err;
    const otherKey = key === 'password' ? 'secret' : 'password';
    if (value === settings.secretNames[otherKey]) return 'Use a different name from the other secret variable.';
    return null;
  }

  function onSecretInput(e) {
    const id = e.target.id;
    clearTimeout(secretTimers[id]);
    const err = secretFieldError(id);
    setSecretError(id, err);
    if (!err) secretTimers[id] = setTimeout(() => commitSecret(id), SECRET_SAVE_DELAY_MS);
  }

  function onSecretChange(e) {
    const id = e.target.id;
    clearTimeout(secretTimers[id]);
    const err = secretFieldError(id);
    setSecretError(id, err);
    if (!err) commitSecret(id);
  }

  function commitSecret(id) {
    const key = SECRET_FIELDS[id];
    const value = $(id).value.trim();
    if (secretFieldError(id) || settings.secretNames[key] === value) return;
    settings.secretNames = Object.assign({}, settings.secretNames, { [key]: value });
    persistSettings(`Saved — ${value}`);
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  function firefoxCommands() {
    const b = typeof browser !== 'undefined' ? browser : null;
    return b && b.commands && typeof b.commands.update === 'function' && typeof b.commands.reset === 'function'
      ? b.commands : null;
  }

  function isEdge() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    const brands = nav.userAgentData && Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands : [];
    return brands.some((b) => /Microsoft Edge/i.test(b && b.brand)) || /\bEdg\//.test(nav.userAgent || '');
  }

  function isMac() {
    const nav = typeof navigator !== 'undefined' ? navigator : {};
    return /Mac|iPhone|iPad/i.test(nav.platform || nav.userAgent || '');
  }

  function shortcutsPageUrl() {
    return isEdge() ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts';
  }

  function loadCommands() {
    const ff = firefoxCommands();
    if (ff && typeof ff.getAll === 'function') return Promise.resolve(ff.getAll()).then((c) => c || []);
    const c = api && api.commands && typeof api.commands.getAll === 'function' ? api.commands : null;
    if (!c) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        c.getAll((cmds) => {
          void lastErrorMessage();
          resolve(Array.isArray(cmds) ? cmds : []);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function commandLabel(cmd) {
    if (cmd.description) return cmd.description;
    return COMMAND_LABELS[cmd.name] || cmd.name;
  }

  // Firefox's commands API: a key, optionally one or two modifiers (at least one of
  // them not Shift), or a function/media key on its own.
  const FF_MODIFIERS = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', command: 'Command', cmd: 'Command', macctrl: 'MacCtrl', shift: 'Shift' };
  const FF_MOD_ORDER = ['Ctrl', 'Alt', 'Command', 'MacCtrl', 'Shift'];
  const FF_NAMED_KEYS = ['Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right'];
  const FF_MEDIA_KEYS = ['MediaNextTrack', 'MediaPlayPause', 'MediaPrevTrack', 'MediaStop'];

  /** { value } (canonical, '' clears the shortcut) or { error }. */
  function normalizeShortcut(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return { value: '' };
    const parts = raw.split('+').map((p) => p.trim());
    if (parts.some((p) => !p)) return { error: 'Write it like Alt+Shift+E.' };
    const keyRaw = parts.pop();
    let key = null;
    if (/^[a-z0-9]$/i.test(keyRaw)) key = keyRaw.toUpperCase();
    else if (/^f([1-9]|1[0-2])$/i.test(keyRaw)) key = keyRaw.toUpperCase();
    else {
      key = FF_NAMED_KEYS.concat(FF_MEDIA_KEYS).find((k) => k.toLowerCase() === keyRaw.toLowerCase()) || null;
    }
    if (!key) return { error: `${shown(keyRaw)} is not a key Firefox accepts.` };
    const mods = [];
    for (const p of parts) {
      const m = FF_MODIFIERS[p.toLowerCase()];
      if (!m) return { error: `${shown(p)} is not a modifier (use Ctrl, Alt, Shift, Command or MacCtrl).` };
      if (mods.indexOf(m) !== -1) return { error: `${m} appears twice.` };
      mods.push(m);
    }
    if (FF_MEDIA_KEYS.indexOf(key) !== -1) {
      return mods.length ? { error: 'Media keys cannot have modifiers.' } : { value: key };
    }
    if (mods.length > 2) return { error: 'Use at most two modifiers.' };
    const isFn = /^F\d+$/.test(key);
    if (!isFn && !mods.some((m) => m !== 'Shift')) return { error: 'Add Ctrl, Alt, Command or MacCtrl.' };
    mods.sort((a, b) => FF_MOD_ORDER.indexOf(a) - FF_MOD_ORDER.indexOf(b));
    return { value: mods.concat([key]).join('+') };
  }

  const CODE_KEYS = {
    Comma: 'Comma', Period: 'Period', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Space: 'Space', Insert: 'Insert', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
    ArrowRight: 'Right', MediaTrackNext: 'MediaNextTrack', MediaPlayPause: 'MediaPlayPause',
    MediaTrackPrevious: 'MediaPrevTrack', MediaStop: 'MediaStop'
  };

  /** The shortcut a keydown spells, in Firefox's syntax (null for a bare modifier). */
  function shortcutFromEvent(e) {
    const code = String(e.code || '');
    let key = null;
    let m;
    if ((m = /^Key([A-Z])$/.exec(code))) key = m[1];
    else if ((m = /^Digit([0-9])$/.exec(code))) key = m[1];
    else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
    else if (CODE_KEYS[code]) key = CODE_KEYS[code];
    if (!key) return null;
    const mac = isMac();
    const mods = [];
    if (e.ctrlKey) mods.push(mac ? 'MacCtrl' : 'Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.metaKey && mac) mods.push('Command');
    if (e.shiftKey) mods.push('Shift');
    return mods.concat([key]).join('+');
  }

  function renderShortcuts(cmds) {
    const list = $('shortcutList');
    const ff = firefoxCommands();
    list.textContent = '';
    const usable = Array.isArray(cmds) ? cmds.filter((c) => c && typeof c.name === 'string') : null;
    $('shortcutsEmpty').hidden = !!(usable && usable.length);
    $('shortcutsManageBtn').hidden = !!ff || !(usable && usable.length) || !(api && api.tabs && typeof api.tabs.create === 'function');
    $('shortcutsHint').textContent = ff
      ? 'Click a shortcut, press the keys you want, then Save. Leave it empty to turn a shortcut off.'
      : `Shortcuts are set on the browser's own page (${shortcutsPageUrl()}).`;
    (usable || []).forEach((cmd) => {
      const li = document.createElement('li');
      li.className = 'shortcut-row';
      li.dataset.command = cmd.name;
      const desc = document.createElement('div');
      desc.className = 'shortcut-desc';
      const title = document.createElement('strong');
      title.textContent = commandLabel(cmd);
      const small = document.createElement('small');
      small.textContent = cmd.name;
      desc.appendChild(title);
      desc.appendChild(small);
      li.appendChild(desc);
      if (ff) li.appendChild(shortcutEditor(cmd, title));
      else li.appendChild(shortcutDisplay(cmd.shortcut));
      list.appendChild(li);
    });
  }

  function shortcutDisplay(shortcut) {
    if (shortcut) {
      const k = document.createElement('kbd');
      k.textContent = shortcut;
      return k;
    }
    const span = document.createElement('span');
    span.className = 'not-set';
    span.textContent = 'Not set';
    return span;
  }

  function shortcutEditor(cmd, title) {
    const wrap = document.createElement('div');
    wrap.className = 'shortcut-edit';
    const safe = cmd.name.replace(/[^A-Za-z0-9_-]/g, '_');
    const titleId = `shortcutTitle-${safe}`;
    title.id = titleId;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input mono';
    input.id = `shortcut-${safe}`;
    input.value = cmd.shortcut || '';
    input.placeholder = 'Not set';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-labelledby', titleId);
    const errId = `shortcutError-${safe}`;
    input.setAttribute('aria-describedby', errId);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn';
    save.textContent = 'Save';
    save.setAttribute('aria-label', `Save shortcut for ${commandLabel(cmd)}`);
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn';
    reset.textContent = 'Reset';
    reset.setAttribute('aria-label', `Reset shortcut for ${commandLabel(cmd)} to the default`);
    const err = document.createElement('span');
    err.className = 'field-error';
    err.id = errId;
    err.setAttribute('role', 'alert');
    const setErr = (msg) => {
      err.textContent = msg || '';
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return; // keep the page keyboard-navigable
      if (e.key === 'Escape') {
        e.preventDefault();
        input.value = cmd.shortcut || '';
        setErr('');
        return;
      }
      if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        saveShortcut(cmd, input, setErr);
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        input.value = '';
        setErr('');
        return;
      }
      const combo = shortcutFromEvent(e);
      if (combo && (e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(combo) || /^Media/.test(combo))) {
        e.preventDefault();
        input.value = combo;
        const n = normalizeShortcut(combo);
        setErr(n.error || '');
      }
    });
    save.addEventListener('click', () => saveShortcut(cmd, input, setErr));
    reset.addEventListener('click', () => resetShortcut(cmd, setErr));
    wrap.appendChild(input);
    wrap.appendChild(save);
    wrap.appendChild(reset);
    wrap.appendChild(err);
    return wrap;
  }

  function saveShortcut(cmd, input, setErr) {
    const n = normalizeShortcut(input.value);
    if (n.error) {
      setErr(n.error);
      input.focus();
      return Promise.resolve(false);
    }
    setErr('');
    input.value = n.value;
    return Promise.resolve()
      .then(() => firefoxCommands().update({ name: cmd.name, shortcut: n.value }))
      .then(() => {
        showStatus(n.value ? `Shortcut set to ${n.value}` : 'Shortcut turned off');
        return refreshShortcuts({ focusCommand: cmd.name });
      }, (err) => {
        setErr((err && err.message) || 'The browser rejected this shortcut.');
        return false;
      });
  }

  function resetShortcut(cmd, setErr) {
    return Promise.resolve()
      .then(() => firefoxCommands().reset(cmd.name))
      .then(() => {
        showStatus('Shortcut reset to the default');
        return refreshShortcuts({ focusCommand: cmd.name });
      }, (err) => {
        setErr((err && err.message) || 'Could not reset this shortcut.');
        return false;
      });
  }

  function refreshShortcuts(opts) {
    return loadCommands().then((cmds) => {
      renderShortcuts(cmds);
      const name = opts && opts.focusCommand;
      if (name) {
        const row = Array.prototype.find.call($('shortcutList').children, (li) => li.dataset.command === name);
        const input = row && row.querySelector('input');
        if (input) input.focus();
      }
      return true;
    }, () => {
      renderShortcuts(null);
      return false;
    });
  }

  function openShortcutsPage() {
    const url = shortcutsPageUrl();
    const errEl = $('shortcutsManageError');
    errEl.textContent = '';
    const fail = () => { errEl.textContent = `Open ${url} in a new tab to change shortcuts.`; };
    try {
      const r = api.tabs.create({ url }, () => { if (lastErrorMessage()) fail(); });
      if (r && typeof r.then === 'function') r.then(null, fail);
    } catch (err) {
      fail();
    }
  }

  // ── Data: export / import / reset / clears ─────────────────────────────────
  function extensionVersion() {
    try { return api.runtime.getManifest().version || ''; } catch (err) { return ''; }
  }

  function exportPayload() {
    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      extensionVersion: extensionVersion(),
      llSettings: {
        autoAssertions: settings.autoAssertions,
        stepScreenshots: settings.stepScreenshots,
        testIdAttributes: settings.testIdAttributes.slice(),
        secretNames: Object.assign({}, settings.secretNames),
        variables: settings.variables,
        healthAutoCheck: settings.healthAutoCheck
      },
      llFramework: framework,
      llLanguage: language
    };
  }

  function exportSettings() {
    const json = JSON.stringify(exportPayload(), null, 2) + '\n';
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'locatra-settings.json';
      a.hidden = true;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showStatus('Settings exported');
    } catch (err) {
      showError('Could not export', err);
    }
    // Revoking at once can cancel the download in some browsers.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /**
   * Validates an imported file. All-or-nothing: { ok:true, settings, framework,
   * language } or { ok:false, errors:[…] }. Only known fields are read (one by
   * one, never merged wholesale), so keys like "__proto__" are inert.
   */
  function parseImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { ok: false, errors: ['The file is not valid JSON.'] };
    }
    if (!isPlainObject(data)) return { ok: false, errors: ['The file must contain a JSON object.'] };
    if (hasOwn(data, 'format') && data.format !== EXPORT_FORMAT) {
      return { ok: false, errors: [`Unknown format ${shown(data.format)} — expected “${EXPORT_FORMAT}”.`] };
    }
    if (hasOwn(data, 'version') && (typeof data.version !== 'number' || data.version > EXPORT_VERSION || data.version < 1)) {
      return { ok: false, errors: [`Unsupported version ${shown(data.version)} — this Locatra reads version ${EXPORT_VERSION}.`] };
    }
    let src;
    if (hasOwn(data, 'llSettings')) {
      if (!isPlainObject(data.llSettings)) return { ok: false, errors: ['“llSettings” must be an object.'] };
      src = data.llSettings;
    } else {
      src = data;
    }
    const recognised = KNOWN_KEYS.some((k) => hasOwn(src, k)) || hasOwn(data, 'llFramework') || hasOwn(data, 'llLanguage');
    if (!recognised) return { ok: false, errors: ['This file does not contain Locatra settings.'] };

    const errors = [];
    const out = defaultSettings();
    BOOL_KEYS.forEach((k) => {
      if (!hasOwn(src, k)) return;
      if (typeof src[k] !== 'boolean') errors.push(`“${k}” must be true or false, not ${shown(src[k])}.`);
      else out[k] = src[k];
    });
    if (hasOwn(src, 'testIdAttributes')) {
      const list = src.testIdAttributes;
      if (!Array.isArray(list)) {
        errors.push('“testIdAttributes” must be a list of attribute names.');
      } else if (list.length > MAX_ATTRS) {
        errors.push(`“testIdAttributes” has ${list.length} entries — at most ${MAX_ATTRS} are allowed.`);
      } else {
        const names = [];
        list.forEach((v) => {
          const name = typeof v === 'string' ? v.trim().toLowerCase() : v;
          const err = typeof name === 'string' ? attrNameError(name) : `${shown(v)} is not an attribute name.`;
          if (err) errors.push(err);
          else if (names.indexOf(name) === -1) names.push(name);
        });
        out.testIdAttributes = names;
      }
    }
    if (hasOwn(src, 'secretNames')) {
      const sn = src.secretNames;
      if (!isPlainObject(sn)) {
        errors.push('“secretNames” must be an object.');
      } else {
        ['password', 'secret'].forEach((k) => {
          if (!hasOwn(sn, k)) return;
          const err = identError(sn[k]);
          if (err) errors.push(`secretNames.${k} ${shown(sn[k])}: ${err}`);
          else out.secretNames[k] = sn[k];
        });
        if (out.secretNames.password === out.secretNames.secret) errors.push('The two secret variable names must differ.');
      }
    }
    let fw = framework;
    let lang = language;
    if (hasOwn(data, 'llFramework') || hasOwn(data, 'llLanguage')) {
      const f = hasOwn(data, 'llFramework') ? data.llFramework : DEFAULT_FRAMEWORK;
      const l = hasOwn(data, 'llLanguage') ? data.llLanguage : null;
      if (typeof f !== 'string' || !frameworkList().some((x) => x.id === f)) {
        errors.push(`Unknown framework ${shown(f)}.`);
      } else if (l != null && (typeof l !== 'string' || !languageList(f).some((x) => x.id === l))) {
        errors.push(`${shown(l)} is not a language for ${f}.`);
      } else {
        const r = resolveOutput(f, l);
        fw = r.framework;
        lang = r.language;
      }
    }
    if (errors.length) return { ok: false, errors };
    return { ok: true, settings: out, framework: fw, language: lang };
  }

  function showImportErrors(errors) {
    const box = $('importErrorBox');
    const list = $('importErrors');
    list.textContent = '';
    if (!errors || !errors.length) {
      box.hidden = true;
      return;
    }
    $('importErrorTitle').textContent = 'Nothing was imported:';
    errors.slice(0, 8).forEach((msg) => {
      const li = document.createElement('li');
      li.textContent = msg;
      list.appendChild(li);
    });
    if (errors.length > 8) {
      const li = document.createElement('li');
      li.textContent = `…and ${errors.length - 8} more.`;
      list.appendChild(li);
    }
    box.hidden = false;
  }

  function readFileText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function importFile(file) {
    showImportErrors(null);
    if (!file) return Promise.resolve(false);
    if (file.size > IMPORT_MAX_BYTES) {
      showImportErrors([`The file is too large (${Math.ceil(file.size / 1024)} KB) — settings files are a few KB.`]);
      showStatus('Import failed', 'error');
      return Promise.resolve(false);
    }
    return readFileText(file).then((text) => applyImport(text), (err) => {
      showImportErrors([`Could not read the file${err && err.message ? ': ' + err.message : ''}.`]);
      showStatus('Import failed', 'error');
      return false;
    });
  }

  function applyImport(text) {
    const parsed = parseImport(text);
    if (!parsed.ok) {
      showImportErrors(parsed.errors);
      showStatus('Import failed', 'error');
      return Promise.resolve(false);
    }
    settings = parsed.settings;
    extras = {};
    framework = parsed.framework;
    language = parsed.language;
    renderAll();
    return storageSet({ [SETTINGS_KEY]: settingsForStorage(), [FW_KEY]: framework, [LANG_KEY]: language })
      .then(() => storageRemove(LEGACY_ATTRS_KEY))
      .then(() => {
        showStatus('Settings imported');
        return true;
      }, (err) => {
        showError('Could not import', err);
        return false;
      });
  }

  function confirmAction(message) {
    try { return window.confirm(message); } catch (err) { return false; }
  }

  function resetSettings() {
    if (!confirmAction('Reset every Locatra setting to its default? Recordings and watched locators are kept.')) return Promise.resolve(false);
    settings = defaultSettings();
    extras = {};
    framework = DEFAULT_FRAMEWORK;
    language = DEFAULT_LANGUAGE;
    showImportErrors(null);
    setAttrError('');
    renderAll();
    return storageSet({ [SETTINGS_KEY]: settingsForStorage(), [FW_KEY]: framework, [LANG_KEY]: language })
      .then(() => storageRemove(LEGACY_ATTRS_KEY))
      .then(() => {
        showStatus('Settings reset to defaults');
        return true;
      }, (err) => {
        showError('Could not reset', err);
        return false;
      });
  }

  function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  function watchedCount(v) {
    if (!isPlainObject(v) || !isPlainObject(v.sites)) return 0;
    return Object.keys(v.sites).reduce((sum, k) => sum + (Array.isArray(v.sites[k]) ? v.sites[k].length : 0), 0);
  }

  function refreshDataCounts() {
    return storageGet(null).then((all) => {
      const timelines = Object.keys(all).filter((k) => RECORDER_KEY_RE.test(k)).length;
      const watched = watchedCount(all[WATCHED_KEY]);
      $('timelineCount').textContent = timelines
        ? `${plural(timelines, 'saved timeline', 'saved timelines')}, one per browser window.`
        : 'No saved timelines.';
      $('watchedCount').textContent = watched
        ? `${plural(watched, 'watched locator', 'watched locators')}.`
        : 'No watched locators.';
      $('clearTimelinesBtn').disabled = !timelines;
      $('clearWatchedBtn').disabled = !watched;
      return { timelines, watched };
    }, () => null);
  }

  /** Event ids of every step in the given saved timelines (their screenshots are keyed by them). */
  function timelineEventIds(all, keys) {
    const ids = [];
    keys.forEach((k) => {
      const actions = isPlainObject(all[k]) && Array.isArray(all[k].actions) ? all[k].actions : [];
      actions.forEach((a) => {
        if (isPlainObject(a) && typeof a.eventId === 'string' && a.eventId) ids.push(a.eventId);
      });
    });
    return ids;
  }

  /** The cleared steps' screenshots go too; a failure there is not worth failing the clear over. */
  function deleteThumbs(eventIds) {
    if (!eventIds.length) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        api.runtime.sendMessage({ type: 'THUMBS_DELETE', eventIds }, () => {
          void lastErrorMessage();
          resolve();
        });
      } catch (err) {
        resolve();
      }
    });
  }

  function clearTimelines() {
    if (!confirmAction('Delete every saved recorder timeline and its step screenshots? Side panels that are open keep the steps they show until they close.')) return Promise.resolve(false);
    return storageGet(null)
      .then((all) => {
        const keys = Object.keys(all).filter((k) => RECORDER_KEY_RE.test(k));
        const ids = timelineEventIds(all, keys);
        return (keys.length ? storageRemove(keys) : Promise.resolve())
          .then(() => deleteThumbs(ids))
          .then(() => keys.length);
      })
      .then((n) => {
        showStatus(n ? `Cleared ${plural(n, 'timeline', 'timelines')}` : 'No timelines to clear', n ? 'ok' : 'info');
        refreshDataCounts();
        return true;
      }, (err) => {
        showError('Could not clear timelines', err);
        return false;
      });
  }

  function clearScreenshots() {
    if (!confirmAction('Delete every step screenshot?')) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (res) => {
        const err = lastErrorMessage();
        if (err || !res || res.ok !== true) {
          showStatus(`Could not clear screenshots${err || (res && res.error) ? ': ' + (err || res.error) : ''}`, 'error');
          resolve(false);
        } else {
          showStatus('Step screenshots cleared');
          resolve(true);
        }
      };
      try {
        api.runtime.sendMessage({ type: 'THUMBS_CLEAR_ALL' }, done);
      } catch (err) {
        showError('Could not clear screenshots', err);
        resolve(false);
      }
    });
  }

  function clearWatched() {
    if (!confirmAction('Stop watching every locator on every site?')) return Promise.resolve(false);
    return storageRemove(WATCHED_KEY).then(() => {
      showStatus('Watched locators cleared');
      refreshDataCounts();
      return true;
    }, (err) => {
      showError('Could not clear watched locators', err);
      return false;
    });
  }

  // ── Legacy migration ───────────────────────────────────────────────────────
  function migrateLegacy(legacy) {
    const before = settings.testIdAttributes.length;
    const fromLegacy = cleanAttrs(legacy);
    settings.testIdAttributes = cleanAttrs(settings.testIdAttributes.concat(fromLegacy));
    const added = settings.testIdAttributes.length - before;
    // Write the new home first, then drop the old key, so nothing is lost if the
    // page closes in between.
    return storageSet({ [SETTINGS_KEY]: settingsForStorage() })
      .then(() => storageRemove(LEGACY_ATTRS_KEY))
      .then(() => {
        if (added > 0) {
          const n = $('migrationNotice');
          n.textContent = `Moved ${plural(added, 'attribute', 'attributes')} from an earlier version of Locatra into this list.`;
          n.hidden = false;
        }
        renderAttrs();
        return added;
      }, (err) => {
        showError('Could not migrate earlier settings', err);
        return -1;
      });
  }

  // ── Live updates from other pages ──────────────────────────────────────────
  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes) return;
    // This page's own writes come back here too: only a real difference re-renders,
    // so an echo never rebuilds the control that has keyboard focus.
    if (changes[SETTINGS_KEY]) {
      const raw = changes[SETTINGS_KEY].newValue;
      const next = normalizeSettings(raw);
      const nextExtras = extrasOf(raw);
      if (JSON.stringify(next) !== JSON.stringify(settings) || JSON.stringify(nextExtras) !== JSON.stringify(extras)) {
        settings = next;
        extras = nextExtras;
        renderAttrs(attrFocusSnapshot());
        renderToggles();
        renderSecrets();
      }
    }
    if (changes[FW_KEY] || changes[LANG_KEY]) {
      const fw = changes[FW_KEY] ? changes[FW_KEY].newValue : framework;
      const lang = changes[LANG_KEY] ? changes[LANG_KEY].newValue : language;
      const r = resolveOutput(fw || DEFAULT_FRAMEWORK, lang || DEFAULT_LANGUAGE);
      if (r.framework !== framework || r.language !== language) {
        framework = r.framework;
        language = r.language;
        renderOutput();
      }
    }
    if (changes[WATCHED_KEY] || Object.keys(changes).some((k) => RECORDER_KEY_RE.test(k))) refreshDataCounts();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────
  function renderAll() {
    renderAttrs();
    renderOutput();
    renderToggles();
    renderSecrets();
  }

  function renderAbout() {
    let name = 'Locatra';
    try {
      const m = api.runtime.getManifest();
      if (m && m.name) name = m.name;
    } catch (err) { /* outside the extension */ }
    $('aboutName').textContent = name;
    $('aboutVersion').textContent = extensionVersion() || 'unknown';
  }

  function bind() {
    $('testAttrAddBtn').addEventListener('click', addAttr);
    $('testAttrInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addAttr();
      }
    });
    $('testAttrInput').addEventListener('input', () => setAttrError(''));
    $('outFramework').addEventListener('change', onFrameworkChange);
    $('outLanguage').addEventListener('change', onLanguageChange);
    Object.keys(TOGGLES).forEach((id) => $(id).addEventListener('change', onToggle));
    $('shotPermGrantBtn').addEventListener('click', () => requestScreenshotPermission());
    Object.keys(SECRET_FIELDS).forEach((id) => {
      $(id).addEventListener('input', onSecretInput);
      $(id).addEventListener('change', onSecretChange);
    });
    $('shortcutsManageBtn').addEventListener('click', openShortcutsPage);
    $('exportBtn').addEventListener('click', exportSettings);
    $('importBtn').addEventListener('click', () => $('importInput').click());
    $('importInput').addEventListener('change', (e) => {
      const input = e.target;
      const file = input.files && input.files[0];
      importFile(file).then(() => { input.value = ''; });
    });
    $('resetBtn').addEventListener('click', resetSettings);
    $('clearTimelinesBtn').addEventListener('click', clearTimelines);
    $('clearShotsBtn').addEventListener('click', clearScreenshots);
    $('clearWatchedBtn').addEventListener('click', clearWatched);
  }

  function init() {
    if (!$('saveStatus')) return Promise.resolve(false);
    bind();
    renderAbout();
    renderAll();
    if (api && api.storage && api.storage.onChanged) api.storage.onChanged.addListener(onStorageChanged);
    const perms = api && api.permissions;
    if (perms && perms.onAdded && perms.onRemoved) {
      perms.onAdded.addListener(checkScreenshotPermission);
      perms.onRemoved.addListener(checkScreenshotPermission);
    }
    // Back from the browser's shortcuts page: show what changed there.
    window.addEventListener('focus', () => refreshShortcuts());
    checkScreenshotPermission();
    const shortcuts = refreshShortcuts();
    const loaded = storageGet([SETTINGS_KEY, LEGACY_ATTRS_KEY, FW_KEY, LANG_KEY]).then((res) => {
      const raw = res[SETTINGS_KEY];
      settings = normalizeSettings(raw);
      extras = extrasOf(raw);
      const r = resolveOutput(res[FW_KEY], res[LANG_KEY]);
      framework = r.framework;
      language = r.language;
      renderAll();
      if (hasOwn(res, LEGACY_ATTRS_KEY)) return migrateLegacy(res[LEGACY_ATTRS_KEY]);
      return 0;
    }, (err) => {
      showError('Could not load settings', err);
      return -1;
    });
    return Promise.all([loaded, shortcuts, refreshDataCounts()]).then(() => true);
  }

  // A test seam only: the page itself never calls it.
  const ready = document.readyState === 'loading'
    ? new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(init())))
    : init();
  if (typeof window !== 'undefined') {
    window.__LocatraOptions = {
      ready,
      normalizeShortcut,
      parseImport,
      normalizeSettings,
      BUILTIN_TEST_ATTRIBUTES: BUILTIN_TEST_ATTRIBUTES.slice()
    };
  }
})();

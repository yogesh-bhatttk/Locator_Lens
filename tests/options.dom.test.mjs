// @vitest-environment jsdom
//
// The options page (src/options.html + src/options.js): markup and accessibility
// contract, the test-id attribute editor, output defaults, recorder / health
// toggles, the screenshot permission flow, secret variable names, the legacy
// customAttributes migration, live updates and storage failures. Data and keyboard
// shortcuts are in options-data.dom.test.mjs.

/* global LLCodegen */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  $,
  flush,
  loadCodegen,
  openOptions,
  press,
  ROOT,
  setValue,
  status,
  toggle,
} from './options-harness.mjs';

beforeAll(() => loadCodegen());

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const stored = (state) => state.store.llSettings;
const attrRows = () =>
  Array.from($('testAttrList').children).map((li) => li.querySelector('code').textContent);
const priority = () => Array.from($('attrPriority').children).map((li) => li.textContent);

async function addAttr(name, via = 'button') {
  setValue($('testAttrInput'), name, { change: false });
  if (via === 'enter') press($('testAttrInput'), 'Enter');
  else $('testAttrAddBtn').click();
  await flush();
}

describe('markup contract', () => {
  it('loads codegen.js and every plug-in target before options.js, as section G requires', () => {
    const html = readFileSync(join(ROOT, 'src/options.html'), 'utf8');
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    expect(scripts).toEqual([
      'codegen.js',
      'codegen-java.js',
      'codegen-csharp.js',
      'codegen-wdio.js',
      'options.js',
    ]);
    // No inline script (MV3 CSP) and no inline handlers.
    expect(html).not.toMatch(/<script>(?!<)/);
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });

  it('labels every input and select, and every section has a heading', async () => {
    await openOptions();
    document.querySelectorAll('input, select').forEach((el) => {
      if (el.id === 'importInput') return; // driven by the labelled Import button
      const labelled =
        el.closest('label') ||
        (el.id && document.querySelector(`label[for="${el.id}"]`)) ||
        el.getAttribute('aria-label') ||
        el.getAttribute('aria-labelledby');
      expect(labelled, el.id).toBeTruthy();
    });
    document.querySelectorAll('section').forEach((s) => {
      const h = document.getElementById(s.getAttribute('aria-labelledby'));
      expect(h && h.tagName, s.id).toBe('H2');
    });
    expect($('saveStatus').getAttribute('role')).toBe('status');
    expect($('saveStatus').getAttribute('aria-live')).toBe('polite');
    expect([...document.querySelectorAll('.toc a')].map((a) => a.getAttribute('href'))).toEqual([
      '#locators',
      '#output',
      '#recorder',
      '#health',
      '#shortcuts',
      '#data',
      '#about',
    ]);
  });

  it('honours prefers-color-scheme with the side panel’s dark tokens', () => {
    const html = readFileSync(join(ROOT, 'src/options.html'), 'utf8');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toMatch(/:root:not\(\[data-theme\]\)\s*{[^}]*--bg:#1B1A17/);
  });

  it('the read-only built-ins are exactly the ones content.js falls back to', async () => {
    const { seam } = await openOptions();
    const content = readFileSync(join(ROOT, 'src/content.js'), 'utf8');
    const m = /const BUILTIN_TEST_ATTRIBUTES = (\[[^\]]+\]);/.exec(content);
    const builtins = JSON.parse(m[1].replace(/'/g, '"'));
    expect(seam.BUILTIN_TEST_ATTRIBUTES).toEqual(builtins);
    expect([...$('builtinAttrList').children].map((li) => li.textContent)).toEqual(builtins);
  });

  it('shows the version and name from the manifest and links the privacy policy', async () => {
    await openOptions();
    expect($('aboutVersion').textContent).toBe('9.8.7');
    expect($('aboutName').textContent).toBe('Locatra – Smart Locator Automation');
    const a = $('privacyLink');
    expect(a.href).toBe('https://github.com/yogesh-bhatttk/Locator_Lens/blob/master/PRIVACY_POLICY.md');
    expect(a.target).toBe('_blank');
    expect(a.rel).toContain('noopener');
  });

  it('degrades when the manifest cannot be read', async () => {
    await openOptions({ manifest: {} });
    expect($('aboutVersion').textContent).toBe('unknown');
    expect($('aboutName').textContent).toBe('Locatra');
  });
});

describe('defaults', () => {
  it('a fresh install shows every default', async () => {
    await openOptions();
    expect($('setAutoAssertions').checked).toBe(true);
    expect($('setStepScreenshots').checked).toBe(true);
    expect($('setVariables').checked).toBe(true);
    expect($('setHealthAutoCheck').checked).toBe(false);
    expect($('secretPassword').value).toBe('LOCATRA_PASSWORD');
    expect($('secretSecret').value).toBe('LOCATRA_SECRET');
    expect(attrRows()).toEqual([]);
    expect($('testAttrList').hidden).toBe(true);
    expect($('testAttrEmpty').hidden).toBe(false);
    expect($('outFramework').value).toBe('playwright');
    expect($('outLanguage').value).toBe('typescript');
    expect(priority()).toEqual([
      'data-testid',
      'data-qa',
      'data-cy',
      'data-test',
      'data-automation-id',
      'data-e2e',
    ]);
  });

  it('shows what is stored, normalising malformed values to their defaults', async () => {
    await openOptions({
      storage: {
        llSettings: {
          autoAssertions: false,
          stepScreenshots: false,
          variables: false,
          healthAutoCheck: true,
          testIdAttributes: ['data-qa-id', 'bad name', 'DATA-HOOK', 'data-qa-id', 5],
          secretNames: { password: 'APP_PW', secret: '1nvalid' },
        },
      },
    });
    expect($('setAutoAssertions').checked).toBe(false);
    expect($('setStepScreenshots').checked).toBe(false);
    expect($('setVariables').checked).toBe(false);
    expect($('setHealthAutoCheck').checked).toBe(true);
    expect(attrRows()).toEqual(['data-qa-id', 'data-hook']);
    expect($('secretPassword').value).toBe('APP_PW');
    expect($('secretSecret').value).toBe('LOCATRA_SECRET');
  });

  it('a non-object llSettings is treated as missing', async () => {
    await openOptions({ storage: { llSettings: ['x'] } });
    expect($('setAutoAssertions').checked).toBe(true);
  });

  it('runs on DOMContentLoaded when the document is still loading', async () => {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, 'readyState');
    Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
    let opened;
    try {
      opened = openOptions({ storage: { llSettings: { healthAutoCheck: true } } });
      await flush();
      expect($('setHealthAutoCheck').checked).toBe(false); // not initialised yet
    } finally {
      delete document.readyState;
      if (desc) Object.defineProperty(Document.prototype, 'readyState', desc);
    }
    document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await opened;
    expect($('setHealthAutoCheck').checked).toBe(true);
  });

  it('does nothing on a page without its markup', async () => {
    document.body.innerHTML = '';
    const { state, seam } = await openOptions({ mount: false, storage: { customAttributes: ['data-x'] } });
    expect(await seam.ready).toBe(false);
    expect(state.ops).toEqual([]);
    expect(state.changeListeners).toEqual([]);
  });
});

describe('Locators — test-id attribute editor', () => {
  it('adds an attribute with the button or Enter, lower-cased and trimmed, and saves at once', async () => {
    const { state } = await openOptions();
    await addAttr('  Data-QA-Id ');
    expect(attrRows()).toEqual(['data-qa-id']);
    expect(stored(state).testIdAttributes).toEqual(['data-qa-id']);
    expect(status()).toBe('Added data-qa-id');
    expect($('testAttrInput').value).toBe('');
    expect(document.activeElement).toBe($('testAttrInput'));

    await addAttr('data-hook', 'enter');
    expect(stored(state).testIdAttributes).toEqual(['data-qa-id', 'data-hook']);
    expect(priority()).toEqual([
      'data-qa-id',
      'data-hook',
      'data-testid',
      'data-qa',
      'data-cy',
      'data-test',
      'data-automation-id',
      'data-e2e',
    ]);
    expect([...$('attrPriority').children].filter((li) => li.className === 'custom')).toHaveLength(2);
    expect($('testAttrHelp').textContent).toContain('2 of 20 used');
  });

  it('a built-in may be added to raise its priority; the preview lists it once', async () => {
    await openOptions();
    await addAttr('data-qa');
    expect(priority()).toEqual([
      'data-qa',
      'data-testid',
      'data-cy',
      'data-test',
      'data-automation-id',
      'data-e2e',
    ]);
  });

  it.each([
    ['', 'Enter an attribute name.'],
    ['bad name', 'is not a valid attribute name'],
    ['1abc', 'is not a valid attribute name'],
    ['data-x"onmouseover="alert(1)', 'is not a valid attribute name'],
    ['data-ll-mark', 'own data-ll-*'],
    ['data-locatra-x', 'own data-ll-*'],
    ['a'.repeat(101), 'at most 100 characters'],
  ])('rejects %j with an error and saves nothing', async (name, message) => {
    const { state } = await openOptions();
    await addAttr(name);
    expect($('testAttrError').textContent).toContain(message);
    expect($('testAttrInput').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe($('testAttrInput'));
    expect(state.ops).toEqual([]);
    expect(attrRows()).toEqual([]);
    // Typing again clears the error.
    setValue($('testAttrInput'), 'data-ok', { change: false });
    expect($('testAttrError').textContent).toBe('');
    expect($('testAttrInput').getAttribute('aria-invalid')).toBe('false');
  });

  it('rejects a duplicate, case-insensitively', async () => {
    const { state } = await openOptions({ storage: { llSettings: { testIdAttributes: ['data-hook'] } } });
    await addAttr('DATA-HOOK');
    expect($('testAttrError').textContent).toBe('“data-hook” is already in your list.');
    expect(state.ops).toEqual([]);
  });

  it('error messages show hostile input as text, never as markup', async () => {
    await openOptions();
    await addAttr('<img src=x onerror=alert(1)>');
    expect($('testAttrError').querySelector('img')).toBeNull();
    expect($('testAttrError').textContent).toContain('<img src=x');
  });

  it('holds at most 20: the input is disabled when full and focus moves to the new row', async () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => `data-a${i}`);
    const { state } = await openOptions({ storage: { llSettings: { testIdAttributes: nineteen } } });
    expect($('testAttrInput').disabled).toBe(false);
    await addAttr('data-last');
    expect(attrRows()).toHaveLength(20);
    expect($('testAttrInput').disabled).toBe(true);
    expect($('testAttrAddBtn').disabled).toBe(true);
    expect($('testAttrHelp').textContent).toContain('The list is full');
    expect(document.activeElement.getAttribute('aria-label')).toBe('Remove data-last');
    expect(stored(state).testIdAttributes).toHaveLength(20);
    // Enter on the (disabled) input cannot add a 21st.
    $('testAttrInput').disabled = false;
    await addAttr('data-more', 'enter');
    expect($('testAttrError').textContent).toBe('You can add up to 20 attributes.');
  });

  it('moves rows up and down, keeping focus on the moved row’s button; ends are disabled', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { testIdAttributes: ['data-a', 'data-b', 'data-c'] } },
    });
    const btn = (row, action) => $('testAttrList').children[row].querySelector(`[data-action="${action}"]`);
    expect(btn(0, 'up').disabled).toBe(true);
    expect(btn(2, 'down').disabled).toBe(true);
    expect(btn(1, 'up').getAttribute('aria-label')).toBe('Move data-b up');

    btn(2, 'up').click();
    await flush();
    expect(attrRows()).toEqual(['data-a', 'data-c', 'data-b']);
    expect(stored(state).testIdAttributes).toEqual(['data-a', 'data-c', 'data-b']);
    expect(document.activeElement).toBe(btn(1, 'up'));
    expect(status()).toBe('Moved data-c up');

    btn(1, 'up').click();
    await flush();
    expect(attrRows()).toEqual(['data-c', 'data-a', 'data-b']);
    // At the top the up button is disabled: focus falls back to Remove on that row.
    expect(document.activeElement).toBe(btn(0, 'remove'));

    btn(0, 'down').click();
    await flush();
    expect(attrRows()).toEqual(['data-a', 'data-c', 'data-b']);
    expect(document.activeElement).toBe(btn(1, 'down'));
  });

  it('removes rows, focusing the next row, then the input when the list empties', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { testIdAttributes: ['data-a', 'data-b'] } },
    });
    const remove = (row) => $('testAttrList').children[row].querySelector('[data-action="remove"]');
    remove(1).click();
    await flush();
    expect(attrRows()).toEqual(['data-a']);
    expect(document.activeElement).toBe(remove(0));
    expect(status()).toBe('Removed data-b');
    remove(0).click();
    await flush();
    expect(attrRows()).toEqual([]);
    expect(stored(state).testIdAttributes).toEqual([]);
    expect($('testAttrEmpty').hidden).toBe(false);
    expect(document.activeElement).toBe($('testAttrInput'));
  });

  it('a stale move (row already gone) is ignored', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { testIdAttributes: ['data-a', 'data-b'] } },
    });
    const up = $('testAttrList').children[1].querySelector('[data-action="up"]');
    // Another page empties the list; the old button's handler still runs.
    state.changeListeners.forEach((fn) =>
      fn({ llSettings: { newValue: { testIdAttributes: [] } } }, 'local')
    );
    up.disabled = false;
    up.click();
    await flush();
    expect(attrRows()).toEqual([]);
  });
});

describe('Output', () => {
  it('lists LLCodegen.FRAMEWORKS and languagesFor(framework), plug-in targets included', async () => {
    await openOptions();
    const fws = [...$('outFramework').options].map((o) => o.value);
    expect(fws).toEqual(LLCodegen.FRAMEWORKS.map((f) => f.id));
    const langs = [...$('outLanguage').options].map((o) => o.value);
    expect(langs).toEqual(LLCodegen.languagesFor('playwright').map((l) => l.id));
    expect($('outPreview').textContent).toBe("page.getByTestId('sign-in')");
    expect($('outExt').textContent).toBe('.ts files');
  });

  it('switching framework re-lists languages, falls back to a valid one and saves both keys', async () => {
    const { state } = await openOptions({ storage: { llFramework: 'playwright', llLanguage: 'python' } });
    expect($('outLanguage').value).toBe('python');
    setValue($('outFramework'), 'cypress');
    await flush();
    expect([...$('outLanguage').options].map((o) => o.value)).not.toContain('python');
    expect($('outLanguage').value).toBe('typescript');
    expect(state.store.llFramework).toBe('cypress');
    expect(state.store.llLanguage).toBe('typescript');
    expect(status()).toBe('Saved — Cypress · TypeScript');
    expect($('outPreview').textContent).toMatch(/^cy\./);

    setValue($('outLanguage'), 'javascript');
    await flush();
    expect(state.store.llLanguage).toBe('javascript');
    expect($('outExt').textContent).toBe('.js files');
  });

  it('shows a registered plug-in target and saves it', async () => {
    if (!LLCodegen.FRAMEWORKS.some((f) => f.id === 'zz-test')) {
      LLCodegen.registerTarget({
        framework: { id: 'zz-test', label: 'ZZ Test' },
        languages: [{ id: 'zzlang', label: 'ZZ Lang', ext: '.zz' }],
        locatorExpr: () => 'zz.find("Sign in")',
        actionStatement: () => '',
        wrapScript: () => '',
        pageObject: () => '',
      });
    }
    const { state } = await openOptions();
    setValue($('outFramework'), 'zz-test');
    await flush();
    expect($('outLanguage').value).toBe('zzlang');
    expect($('outPreview').textContent).toBe('zz.find("Sign in")');
    expect($('outExt').textContent).toBe('.zz files');
    expect(state.store).toMatchObject({ llFramework: 'zz-test', llLanguage: 'zzlang' });
    expect(status()).toBe('Saved — ZZ Test · ZZ Lang');
  });

  it('an unknown stored framework/language displays as the nearest valid pair (storage untouched)', async () => {
    const { state } = await openOptions({ storage: { llFramework: 'nope', llLanguage: 'klingon' } });
    expect($('outFramework').value).toBe('playwright');
    expect($('outLanguage').value).toBe('typescript');
    expect(state.store.llFramework).toBe('nope');
  });

  it('a throwing generator leaves a dash instead of breaking the page', async () => {
    await openOptions();
    vi.spyOn(LLCodegen, 'locatorExpr').mockImplementation(() => {
      throw new Error('boom');
    });
    setValue($('outFramework'), 'selenium');
    await flush();
    expect($('outPreview').textContent).toBe('—');
  });

  it('works without LLCodegen (built-in lists)', async () => {
    const saved = globalThis.LLCodegen;
    delete globalThis.LLCodegen;
    try {
      const { state } = await openOptions({ storage: { llFramework: 'cypress', llLanguage: 'python' } });
      expect([...$('outFramework').options].map((o) => o.value)).toEqual([
        'playwright',
        'selenium',
        'cypress',
      ]);
      expect([...$('outLanguage').options].map((o) => o.value)).toEqual(['typescript', 'javascript']);
      expect($('outPreview').textContent).toBe('—');
      expect($('outExt').textContent).toBe('generated code');
      setValue($('outLanguage'), 'javascript');
      await flush();
      expect(state.store.llLanguage).toBe('javascript');
    } finally {
      globalThis.LLCodegen = saved;
    }
  });
});

describe('Recorder and health toggles', () => {
  it.each([
    ['setAutoAssertions', 'autoAssertions', true],
    ['setVariables', 'variables', true],
    ['setHealthAutoCheck', 'healthAutoCheck', false],
    ['setStepScreenshots', 'stepScreenshots', true],
  ])('%s saves llSettings.%s immediately', async (id, key, initial) => {
    const { state } = await openOptions();
    expect($(id).checked).toBe(initial);
    toggle($(id));
    await flush();
    expect(stored(state)[key]).toBe(!initial);
    expect(status()).toBe('Saved');
    toggle($(id));
    await flush();
    expect(stored(state)[key]).toBe(initial);
  });

  it('saving keeps fields this version does not know about', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { futureThing: { a: 1 }, autoAssertions: true } },
    });
    toggle($('setAutoAssertions'));
    await flush();
    expect(stored(state)).toEqual({
      futureThing: { a: 1 },
      autoAssertions: false,
      stepScreenshots: true,
      testIdAttributes: [],
      secretNames: { password: 'LOCATRA_PASSWORD', secret: 'LOCATRA_SECRET' },
      variables: true,
      healthAutoCheck: false,
    });
  });

  it('the status message clears itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opened = openOptions();
    await vi.advanceTimersByTimeAsync(50);
    await opened;
    toggle($('setVariables'));
    await vi.advanceTimersByTimeAsync(10);
    expect(status()).toBe('Saved');
    await vi.advanceTimersByTimeAsync(3100);
    expect(status()).toBe('');
  });
});

describe('Recorder — screenshot permission (<all_urls>)', () => {
  it('shows the notice when screenshots are on but access is missing, and grants from the button', async () => {
    const { state } = await openOptions({ granted: false });
    expect($('shotPermNotice').hidden).toBe(false);
    expect($('shotPermDeclined').hidden).toBe(true);
    $('shotPermGrantBtn').click();
    // Asked synchronously inside the click — the browser needs the user gesture.
    expect(state.permRequests).toEqual([{ origins: ['<all_urls>'] }]);
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
    expect(status()).toBe('Screenshot access granted');
  });

  it('a declined request explains the consequence', async () => {
    await openOptions({ granted: false, grantOnRequest: false });
    $('shotPermGrantBtn').click();
    await flush();
    expect($('shotPermNotice').hidden).toBe(false);
    expect($('shotPermDeclined').hidden).toBe(false);
  });

  it('turning screenshots on asks for access in the same gesture', async () => {
    const { state } = await openOptions({
      granted: false,
      storage: { llSettings: { stepScreenshots: false } },
    });
    expect($('shotPermNotice').hidden).toBe(true);
    toggle($('setStepScreenshots'));
    expect(state.permRequests).toHaveLength(1);
    await flush();
    expect(stored(state).stepScreenshots).toBe(true);
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('does not ask when access is already granted, nor when turning screenshots off', async () => {
    const { state } = await openOptions({
      granted: true,
      storage: { llSettings: { stepScreenshots: false } },
    });
    toggle($('setStepScreenshots'));
    toggle($('setStepScreenshots'));
    await flush();
    expect(state.permRequests).toEqual([]);
  });

  it('handles a promise-style request API (Firefox), resolved or rejected', async () => {
    const { state } = await openOptions({ granted: false, promiseRequest: true });
    $('shotPermGrantBtn').click();
    await flush();
    expect(state.granted).toBe(true);
    expect($('shotPermNotice').hidden).toBe(true);

    await openOptions({ granted: false, promiseRequest: 'reject', grantOnRequest: false });
    $('shotPermGrantBtn').click();
    await flush();
    expect($('shotPermDeclined').hidden).toBe(false);
  });

  it('a request that throws counts as declined', async () => {
    await openOptions({ granted: false, requestThrows: true });
    $('shotPermGrantBtn').click();
    await flush();
    expect($('shotPermDeclined').hidden).toBe(false);
  });

  it('follows permissions granted or revoked elsewhere', async () => {
    const { state } = await openOptions({ granted: true });
    expect($('shotPermNotice').hidden).toBe(true);
    state.granted = false;
    state.permListeners.removed.forEach((fn) => fn({ origins: ['<all_urls>'] }));
    await flush();
    expect($('shotPermNotice').hidden).toBe(false);
    state.granted = true;
    state.permListeners.added.forEach((fn) => fn({ origins: ['<all_urls>'] }));
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('without a permissions API there is nothing to ask', async () => {
    await openOptions({ granted: false, beforeInit: (chrome) => delete chrome.permissions });
    expect($('shotPermNotice').hidden).toBe(true);
    $('shotPermGrantBtn').click();
    toggle($('setStepScreenshots'));
    toggle($('setStepScreenshots'));
    await flush();
    expect($('shotPermNotice').hidden).toBe(true);
  });

  it('a contains() that throws or answers nonsense leaves the state unknown (no notice)', async () => {
    await openOptions({ granted: 'maybe' });
    expect($('shotPermNotice').hidden).toBe(true);
    await openOptions({
      granted: false,
      beforeInit: (chrome) => {
        chrome.permissions.contains = () => {
          throw new Error('nope');
        };
      },
    });
    expect($('shotPermNotice').hidden).toBe(true);
  });
});

describe('Recorder — secret variable names', () => {
  it('saves a valid name after a short pause while typing, and immediately on change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const opened = openOptions();
    await vi.advanceTimersByTimeAsync(50);
    const { state } = await opened;
    const pw = $('secretPassword');
    pw.focus();
    setValue(pw, 'APP_PASS', { change: false });
    await vi.advanceTimersByTimeAsync(100);
    expect(state.ops).toEqual([]); // not yet: still typing
    await vi.advanceTimersByTimeAsync(400);
    expect(stored(state).secretNames).toEqual({ password: 'APP_PASS', secret: 'LOCATRA_SECRET' });
    expect(status()).toBe('Saved — APP_PASS');

    setValue($('secretSecret'), '  OTP_CODE ');
    await vi.advanceTimersByTimeAsync(10);
    expect(stored(state).secretNames.secret).toBe('OTP_CODE');
    // The pending debounce for the same field does not save twice.
    await vi.advanceTimersByTimeAsync(500);
    expect(state.ops.filter((o) => o === 'set:llSettings')).toHaveLength(2);
  });

  it.each([
    ['', 'Enter a variable name.'],
    ['1PASS', 'Use letters, digits and “_”'],
    ['MY-PASS', 'Use letters, digits and “_”'],
    ['A'.repeat(65), 'At most 64 characters.'],
    ['LOCATRA_SECRET', 'Use a different name from the other secret variable.'],
  ])('rejects %j and keeps the saved name', async (value, message) => {
    const { state } = await openOptions();
    const pw = $('secretPassword');
    setValue(pw, value);
    await flush();
    expect($('secretPasswordError').textContent).toContain(message);
    expect(pw.getAttribute('aria-invalid')).toBe('true');
    expect(state.ops).toEqual([]);
    // Correcting it clears the error and saves.
    setValue(pw, 'GOOD_NAME');
    await flush();
    expect($('secretPasswordError').textContent).toBe('');
    expect(pw.getAttribute('aria-invalid')).toBe('false');
    expect(stored(state).secretNames.password).toBe('GOOD_NAME');
  });

  it('re-entering the saved value writes nothing', async () => {
    const { state } = await openOptions();
    setValue($('secretSecret'), 'LOCATRA_SECRET');
    await flush();
    expect(state.ops).toEqual([]);
  });

  it('a live change from elsewhere does not overwrite a field the user is fixing', async () => {
    const { state } = await openOptions();
    const pw = $('secretPassword');
    pw.focus();
    setValue(pw, 'bad name', { change: false });
    state.changeListeners.forEach((fn) =>
      fn({ llSettings: { newValue: { secretNames: { password: 'OTHER', secret: 'S2' } } } }, 'local')
    );
    expect(pw.value).toBe('bad name');
    expect($('secretSecret').value).toBe('S2');
  });
});

describe('legacy customAttributes migration', () => {
  it('merges the legacy list after the current one, writes llSettings, then removes the old key', async () => {
    const { state } = await openOptions({
      storage: {
        llSettings: { testIdAttributes: ['data-qa-id'], healthAutoCheck: true },
        customAttributes: ['data-hook', 'DATA-QA-ID', 'not valid', 42, 'data-e2e'],
      },
    });
    expect(state.ops).toEqual(['set:llSettings', 'remove:customAttributes']);
    expect(state.store.customAttributes).toBeUndefined();
    expect(stored(state).testIdAttributes).toEqual(['data-qa-id', 'data-hook', 'data-e2e']);
    expect(stored(state).healthAutoCheck).toBe(true);
    expect(attrRows()).toEqual(['data-qa-id', 'data-hook', 'data-e2e']);
    expect($('migrationNotice').hidden).toBe(false);
    expect($('migrationNotice').textContent).toBe(
      'Moved 2 attributes from an earlier version of Locatra into this list.'
    );
  });

  it('a legacy list with nothing new is removed quietly', async () => {
    const { state } = await openOptions({ storage: { customAttributes: [] } });
    expect(state.ops).toEqual(['set:llSettings', 'remove:customAttributes']);
    expect($('migrationNotice').hidden).toBe(true);
  });

  it('caps the merged list at 20', async () => {
    const legacy = Array.from({ length: 30 }, (_, i) => `data-l${i}`);
    const { state } = await openOptions({ storage: { customAttributes: legacy } });
    expect(stored(state).testIdAttributes).toHaveLength(20);
    expect($('migrationNotice').textContent).toContain('Moved 20 attributes');
  });

  it('a non-array legacy value is just removed', async () => {
    const { state } = await openOptions({ storage: { customAttributes: 'data-hook' } });
    expect(stored(state).testIdAttributes).toEqual([]);
    expect(state.store.customAttributes).toBeUndefined();
  });

  it('a failed write keeps the legacy key and reports it', async () => {
    const { state } = await openOptions({
      storage: { customAttributes: ['data-hook'] },
      beforeInit: (chrome, st) => (st.failNext.set = 'QUOTA_BYTES quota exceeded'),
    });
    expect(state.store.customAttributes).toEqual(['data-hook']);
    expect(status()).toBe('Could not migrate earlier settings: QUOTA_BYTES quota exceeded');
    expect($('saveStatus').dataset.tone).toBe('error');
  });
});

describe('live updates from other pages', () => {
  it('follows llSettings, llFramework and llLanguage written elsewhere', async () => {
    const { state } = await openOptions();
    const fire = (changes, area = 'local') => state.changeListeners.forEach((fn) => fn(changes, area));
    fire({
      llSettings: {
        newValue: { autoAssertions: false, testIdAttributes: ['data-x'], secretNames: { password: 'PW2' } },
      },
    });
    expect($('setAutoAssertions').checked).toBe(false);
    expect(attrRows()).toEqual(['data-x']);
    expect($('secretPassword').value).toBe('PW2');
    fire({ llFramework: { newValue: 'selenium' }, llLanguage: { newValue: 'python' } });
    expect($('outFramework').value).toBe('selenium');
    expect($('outLanguage').value).toBe('python');
    fire({ llLanguage: { newValue: 'javascript' } });
    expect($('outLanguage').value).toBe('javascript');
    fire({ llFramework: { newValue: undefined } });
    expect($('outFramework').value).toBe('playwright');
    fire({ llSettings: { newValue: undefined } });
    expect($('setAutoAssertions').checked).toBe(true);
    // Other areas and empty events are ignored.
    fire({ llSettings: { newValue: { autoAssertions: false } } }, 'sync');
    expect($('setAutoAssertions').checked).toBe(true);
    expect(() => fire(undefined)).not.toThrow();
    expect(state.ops).toEqual([]);
  });

  it('this page’s own echo does not rebuild the list under keyboard focus', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { testIdAttributes: ['data-a', 'data-b'] } },
    });
    const down = $('testAttrList').children[0].querySelector('[data-action="down"]');
    down.click();
    const focused = document.activeElement; // the moved row's control, before the echo
    await flush(); // the set lands and storage.onChanged echoes it back
    expect(document.activeElement).toBe(focused); // same node: the echo rebuilt nothing
    const moved = $('testAttrList').children[1].querySelector('[data-action="down"]');
    expect(state.ops).toEqual(['set:llSettings']);
    expect(moved.disabled).toBe(true);
    expect(document.activeElement).toBe(
      $('testAttrList').children[1].querySelector('[data-action="remove"]')
    );
  });

  it('a real change from elsewhere keeps focus on the same row and control', async () => {
    const { state } = await openOptions({
      storage: { llSettings: { testIdAttributes: ['data-a', 'data-b'] } },
    });
    $('testAttrList').children[1].querySelector('[data-action="up"]').focus();
    state.changeListeners.forEach((fn) =>
      fn({ llSettings: { newValue: { testIdAttributes: ['data-a', 'data-b', 'data-c'] } } }, 'local')
    );
    expect(attrRows()).toEqual(['data-a', 'data-b', 'data-c']);
    expect(document.activeElement).toBe($('testAttrList').children[1].querySelector('[data-action="up"]'));
  });
});

describe('storage failures', () => {
  it('a failed save is announced as an error', async () => {
    const { state } = await openOptions();
    state.failNext.set = 'disk full';
    toggle($('setVariables'));
    await flush();
    expect(status()).toBe('Could not save: disk full');
    expect($('saveStatus').dataset.tone).toBe('error');

    state.failNext.set = 'disk full';
    setValue($('outFramework'), 'selenium');
    await flush();
    expect(status()).toBe('Could not save: disk full');
  });

  it('a failed load is announced and the defaults stay on screen', async () => {
    await openOptions({
      storage: { llSettings: { autoAssertions: false } },
      beforeInit: (chrome, st) => (st.failNext.get = 'storage corrupted'),
    });
    expect(status()).toBe('Could not load settings: storage corrupted');
    expect($('setAutoAssertions').checked).toBe(true);
  });

  it('without any extension API the page still renders its defaults', async () => {
    await openOptions({ noChrome: true });
    expect($('setAutoAssertions').checked).toBe(true);
    expect($('aboutVersion').textContent).toBe('unknown');
    expect($('shortcutsEmpty').hidden).toBe(false);
    toggle($('setVariables'));
    await flush();
    expect(status()).toBe('Could not save: storage is unavailable');
  });
});

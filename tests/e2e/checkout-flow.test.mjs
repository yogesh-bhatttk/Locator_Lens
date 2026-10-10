// Fast guard for the export-run fixture (tests/e2e/fixtures/checkout-flow.json).
// The real runs (npm run test:exports) need browsers and take minutes; this keeps
// the fixture honest on every `npm test`: it must stay in the exact shape the side
// panel stores, cover what it claims to, and export to every framework × language
// with no step lost to a TODO.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const state = JSON.parse(readFileSync(join(ROOT, 'tests/e2e/fixtures/checkout-flow.json'), 'utf8'));
const expectation = JSON.parse(
  readFileSync(join(ROOT, 'tests/e2e/fixtures/checkout-flow.expect.json'), 'utf8')
);

function codegen() {
  const sandbox = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'src/codegen.js'), 'utf8'), sandbox);
  return sandbox.LLCodegen;
}

// The payload content.js's sendRecordedAction() builds, plus its optional keys.
const REQUIRED = [
  'eventId',
  'sequence',
  'timestamp',
  'url',
  'action',
  'value',
  'code',
  'fullCode',
  'target',
  'assertType',
];
const OPTIONAL = [
  'sensitive',
  'secretName',
  'inputType',
  'supersedes',
  'suggested',
  'reason',
  'rect',
  'viewport',
  'values',
  'sensitiveOnScreen',
];

describe('checkout-flow fixture', () => {
  it('is a stored recorder state (llRecorderState:<windowId>)', () => {
    for (const key of ['actions', 'seenKeys', 'codePreview', 'codeEdited', 'lastPageUrl', 'updatedAt']) {
      expect(state, key).toHaveProperty(key);
    }
    expect(state.seenKeys).toEqual(state.actions.map((a) => `eid:${a.eventId}`));
  });

  it('holds steps in the exact shape the content script sends', () => {
    for (const step of state.actions) {
      for (const key of REQUIRED) expect(step, `${step.eventId}.${key}`).toHaveProperty(key);
      for (const key of Object.keys(step))
        expect([...REQUIRED, ...OPTIONAL], `${step.eventId}.${key}`).toContain(key);
    }
    expect(state.actions.map((a) => a.sequence)).toEqual(state.actions.map((_, i) => i + 1));
  });

  it('never stores the password: the sensitive fill and its value check are empty and named', () => {
    const secret = state.actions.filter((a) => a.sensitive);
    expect(secret.map((a) => a.action)).toEqual(['fill', 'assert']);
    expect(secret[0]).toMatchObject({ value: '', secretName: 'LOCATRA_PASSWORD', inputType: 'password' });
    expect(secret[1]).toMatchObject({ value: '', secretName: 'LOCATRA_PASSWORD', assertType: 'toHaveValue' });
    expect(expectation.order.password).toBe('{{LOCATRA_PASSWORD}}');
  });

  it('covers every step kind the export runs are meant to prove', () => {
    const kinds = new Set(state.actions.map((a) => (a.action === 'assert' ? a.assertType : a.action)));
    for (const k of [
      'goto',
      'viewport',
      'hover',
      'fill',
      'selectOption',
      'check',
      'uncheck',
      'click',
      'press',
    ]) {
      expect(kinds, k).toContain(k);
    }
    for (const k of [
      'toBeVisible',
      'toHaveText',
      'toContainText',
      'toBeChecked',
      'toHaveValue',
      'toHaveURL',
    ]) {
      expect(kinds, k).toContain(k);
    }
    expect(state.actions.some((a) => a.target?.kind === 'frame')).toBe(true);
    // A frame known only by position, where <iframe> order (0) and window.frames
    // order (1) differ because an <object> comes first.
    expect(
      state.actions.some(
        (a) => a.target?.kind === 'frame' && !a.target.selector && a.target.framesIndex === 1
      )
    ).toBe(true);
    expect(state.actions.some((a) => Array.isArray(a.values) && a.values.length > 1)).toBe(true);
    expect(state.actions.some((a) => Array.isArray(a.target?.shadowHosts) && a.target.shadowCss)).toBe(true);
    expect(expectation.order.interests).toEqual(['books', 'music']);
    expect(expectation.order.promo).toBe('SPRING-10');
    expect(state.actions.filter((a) => a.action === 'press').map((a) => a.value)).toEqual([
      'Tab',
      'Tab',
      'Shift+Tab',
      'Enter',
    ]);
  });

  it('exports to every framework × language with no step dropped', () => {
    const C = codegen();
    let combos = 0;
    for (const fw of ['playwright', 'selenium', 'cypress']) {
      for (const lang of ['typescript', 'javascript', 'python']) {
        if (!C.isValidCombo(fw, lang)) continue;
        combos++;
        const script = C.testScript(state.actions, fw, lang);
        expect(script, `${fw}/${lang}`).not.toMatch(/TODO/);
        expect(script, `${fw}/${lang}`).toContain('{{BASE}}/checkout');
      }
    }
    expect(combos).toBe(8);
  });
});

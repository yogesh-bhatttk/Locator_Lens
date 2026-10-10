// Test-data variables: LLCodegen.extractVariables / applyVariables / variablesJson and
// the testData / TEST_DATA rendering in every built-in framework × language. The
// generated scripts are not only compared — they are parsed (node --check after a
// TypeScript strip, Python's ast.parse) and their declarations evaluated, so a value
// that does not survive the round trip, or a reference to an undeclared name, fails.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let C;
let I;
let dir;
beforeAll(async () => {
  await import('../src/codegen.js');
  C = globalThis.LLCodegen;
  I = C._internals;
  dir = mkdtempSync(join(tmpdir(), 'locatra-vars-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const COMBOS = [
  ['playwright', 'typescript'],
  ['playwright', 'javascript'],
  ['playwright', 'python'],
  ['selenium', 'typescript'],
  ['selenium', 'javascript'],
  ['selenium', 'python'],
  ['cypress', 'typescript'],
  ['cypress', 'javascript'],
];

let python = true;
try {
  execFileSync('python3', ['--version'], { stdio: 'pipe' });
} catch {
  python = false; // no interpreter on this machine: nothing to parse with
}

const URL = 'https://shop.example/checkout';
const label = (value, o = {}) => ({ kind: 'label', value, ...o });
const testid = (value) => ({ kind: 'testid', attr: 'data-testid', value });
const id = (value) => ({ kind: 'id', value });
const fill = (target, value, o = {}) => ({ action: 'fill', target, value, url: URL, ...o });
const select = (target, value, o = {}) => ({ action: 'selectOption', target, value, url: URL, ...o });

/** The derived name for one fill step on `target`. */
const nameFor = (target, o = {}) => I.deriveVariableName(fill(target, 'x', o));

// ── extraction ──────────────────────────────────────────────────────────────────

describe('extractVariables', () => {
  it('returns one variable per distinct (name, value), in order of first use', () => {
    const steps = [
      { eventId: 'e1', action: 'goto', value: URL, url: URL },
      fill(label('First name'), 'Ada', { eventId: 'e2' }),
      fill({ kind: 'role', role: 'textbox', name: 'Last name' }, 'Lovelace', { eventId: 'e3' }),
      fill(testid('checkout-email'), 'ada@example.com', { eventId: 'e4', inputType: 'email' }),
      select({ kind: 'role', role: 'combobox', name: 'Country' }, 'Ireland', { eventId: 'e5' }),
      { eventId: 'e6', action: 'click', target: id('go'), url: URL },
      fill(label('First name'), 'Ada', { eventId: 'e7' }),
    ];
    expect(C.extractVariables(steps)).toEqual([
      { name: 'firstName', value: 'Ada', kind: 'fill', eventIds: ['e2', 'e7'], indexes: [1, 6] },
      { name: 'lastName', value: 'Lovelace', kind: 'fill', eventIds: ['e3'], indexes: [2] },
      { name: 'checkoutEmail', value: 'ada@example.com', kind: 'fill', eventIds: ['e4'], indexes: [3] },
      { name: 'country', value: 'Ireland', kind: 'select', eventIds: ['e5'], indexes: [4] },
    ]);
  });

  it('leaves out sensitive, suggested, empty, non-string and locator-less values', () => {
    const steps = [
      fill(label('Password'), 'hunter2', { eventId: 'p', sensitive: true }),
      fill(label('Code'), 'abc', { eventId: 's', suggested: true }),
      fill(label('Empty'), '', { eventId: 'e' }),
      fill(label('Number'), 42, { eventId: 'n' }),
      fill(label('Null'), null, { eventId: 'nl' }),
      fill(null, 'no target', { eventId: 't' }),
      fill({ kind: 'frame', selector: '#f', index: 0 }, 'frame only', { eventId: 'f' }),
      { action: 'upload', target: id('file'), value: 'a.txt', eventId: 'u' },
      { action: 'assert', assertType: 'toHaveValue', target: id('x'), value: 'v', eventId: 'a' },
      { action: 'press', value: 'Enter', eventId: 'k' },
      null,
      'fill',
      fill(label('Kept'), 'yes', { eventId: 'k2', sensitive: null }),
    ];
    expect(C.extractVariables(steps)).toEqual([
      { name: 'kept', value: 'yes', kind: 'fill', eventIds: ['k2'], indexes: [12] },
    ]);
  });

  it('returns [] for anything that is not an array of steps', () => {
    expect(C.extractVariables()).toEqual([]);
    expect(C.extractVariables(null)).toEqual([]);
    expect(C.extractVariables({ length: 1, 0: fill(label('A'), 'a') })).toEqual([]);
    expect(C.extractVariables([])).toEqual([]);
  });

  it('suffixes a name used for different values (2, 3, …) and merges repeats into the right one', () => {
    const steps = [
      fill(label('Email'), 'a@x.io', { eventId: '1' }),
      fill(label('Email'), 'b@x.io', { eventId: '2' }),
      fill(label('Email'), 'c@x.io', { eventId: '3' }),
      fill(label('Email'), 'b@x.io', { eventId: '4' }),
      fill(label('Email'), 'a@x.io', { eventId: '5' }),
    ];
    expect(C.extractVariables(steps).map((v) => [v.name, v.value, v.eventIds])).toEqual([
      ['email', 'a@x.io', ['1', '5']],
      ['email2', 'b@x.io', ['2', '4']],
      ['email3', 'c@x.io', ['3']],
    ]);
  });

  it('skips a suffix another variable already owns', () => {
    const steps = [
      fill(label('Email 2'), 'second', { eventId: '1' }), // derives "email2"
      fill(label('Email'), 'a', { eventId: '2' }),
      fill(label('Email'), 'b', { eventId: '3' }),
    ];
    const names = C.extractVariables(steps).map((v) => v.name);
    expect(names).toEqual(['email2', 'email', 'email3']);
  });

  it('merges selects and fills of the same name and value, keeping the first kind', () => {
    const vars = C.extractVariables([
      select(label('Size'), 'M', { eventId: '1' }),
      fill(label('Size'), 'M', { eventId: '2' }),
    ]);
    expect(vars).toEqual([
      { name: 'size', value: 'M', kind: 'select', eventIds: ['1', '2'], indexes: [0, 1] },
    ]);
  });

  it("uses a step's own varName when it is a valid name, and derives one otherwise", () => {
    const vars = C.extractVariables([
      fill(label('First name'), 'Ada', { eventId: '1', varName: 'customerName' }),
      fill(label('Last name'), 'L', { eventId: '2', varName: 'class' }), // reserved
      fill(label('City'), 'Cork', { eventId: '3', varName: '1city' }),
      fill(label('Zip'), 'T12', { eventId: '4', varName: 'zip-code' }),
      fill(label('Street'), 'Main', { eventId: '5', varName: 'a'.repeat(65) }),
      fill(label('Note'), 'n', { eventId: '6', varName: 42 }),
      fill(label('Phone'), '1', { eventId: '7', varName: '' }),
    ]);
    expect(vars.map((v) => v.name)).toEqual([
      'customerName',
      'lastName',
      'city',
      'zip',
      'street',
      'note',
      'phone',
    ]);
  });

  it("claims the user's names before derived ones, so a rename is never pushed to a suffix", () => {
    const vars = C.extractVariables([
      fill(label('Email'), 'derived@x.io', { eventId: '1' }),
      fill(label('Contact'), 'chosen@x.io', { eventId: '2', varName: 'email' }),
    ]);
    expect(vars.map((v) => [v.name, v.value])).toEqual([
      ['email2', 'derived@x.io'],
      ['email', 'chosen@x.io'],
    ]);
  });

  it('merges a derived and an explicit name when the value is the same', () => {
    const vars = C.extractVariables([
      fill(label('Email'), 'same@x.io', { eventId: '1' }),
      fill(label('Other'), 'same@x.io', { eventId: '2', varName: 'email' }),
    ]);
    expect(vars).toEqual([
      { name: 'email', value: 'same@x.io', kind: 'fill', eventIds: ['1', '2'], indexes: [0, 1] },
    ]);
  });

  it('suffixes the second explicit use of a name with a different value', () => {
    const vars = C.extractVariables([
      fill(label('A'), 'one', { eventId: '1', varName: 'code' }),
      fill(label('B'), 'two', { eventId: '2', varName: 'code' }),
    ]);
    expect(vars.map((v) => [v.name, v.value])).toEqual([
      ['code', 'one'],
      ['code2', 'two'],
    ]);
  });

  it('treats names whose Python keys collide as the same name', () => {
    const vars = C.extractVariables([
      fill(label('X'), 'snake', { eventId: '1', varName: 'first_name' }),
      fill(label('First name'), 'camel', { eventId: '2' }),
      fill(label('Y'), 'other', { eventId: '3', varName: 'FirstName' }),
    ]);
    expect(vars.map((v) => v.name)).toEqual(['first_name', 'firstName2', 'FirstName3']); // FirstName2 is first_name2 too
    const keys = vars.map((v) => C.variableKey(v.name, 'python'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps steps without an eventId addressable by position', () => {
    const vars = C.extractVariables([
      { action: 'goto', value: URL },
      fill(label('Name'), 'Ada'),
      fill(label('Name'), 'Ada', { eventId: 0 }),
      fill(label('Name'), 'Ada', { eventId: '' }),
    ]);
    expect(vars).toEqual([{ name: 'name', value: 'Ada', kind: 'fill', eventIds: [0], indexes: [1, 2, 3] }]);
  });

  it('is deterministic and never mutates the steps', () => {
    const steps = [
      fill(label('Email'), 'a', { eventId: '1' }),
      fill(label('Email'), 'b', { eventId: '2', varName: 'mail' }),
      select(label('Plan'), 'Pro', { eventId: '3' }),
    ];
    const before = JSON.stringify(steps);
    const a = C.extractVariables(steps);
    const b = C.extractVariables(JSON.parse(before));
    expect(a).toEqual(b);
    expect(JSON.stringify(steps)).toBe(before);
  });

  it('caps a suffixed long name at 64 characters', () => {
    const long = 'a'.repeat(64);
    const vars = C.extractVariables([
      fill(label('x'), '1', { varName: long }),
      fill(label('y'), '2', { varName: long }),
    ]);
    expect(vars[1].name).toBe('a'.repeat(60) + '2');
    expect(C.isValidVariableName(vars[1].name)).toBe(true);
  });
});

// ── name derivation ─────────────────────────────────────────────────────────────

describe('variable names', () => {
  it('derives lowerCamelCase from every kind of target', () => {
    expect(nameFor(label('First name'))).toBe('firstName');
    expect(nameFor({ kind: 'role', role: 'textbox', name: 'Last name' })).toBe('lastName');
    expect(nameFor({ kind: 'placeholder', value: 'Street address' })).toBe('streetAddress');
    expect(nameFor(testid('checkout-email'))).toBe('checkoutEmail');
    expect(nameFor({ kind: 'testid', attr: 'data-qa', value: 'zipCode' })).toBe('zipCode');
    expect(nameFor(id('first_name'))).toBe('firstName');
    expect(nameFor({ kind: 'name', value: 'notes' })).toBe('notes');
    expect(nameFor({ kind: 'text', value: 'Search the catalogue' })).toBe('searchCatalogue');
    expect(nameFor({ kind: 'title', value: 'Coupon code' })).toBe('couponCode');
    expect(nameFor({ kind: 'altText', value: 'Avatar URL' })).toBe('avatarUrl');
  });

  it('looks through frames and chains to the element itself', () => {
    const framed = {
      kind: 'frame',
      selector: '#outer',
      index: 0,
      child: { kind: 'frame', index: 1, child: label('Card number') },
    };
    expect(nameFor(framed)).toBe('cardNumber');
    expect(nameFor({ kind: 'chain', parent: id('form'), child: label('Postcode') })).toBe('postcode');
    expect(nameFor({ kind: 'chain', parent: label('Parent only') })).toBe('parentOnly');
    expect(
      nameFor({
        kind: 'chain',
        parent: { kind: 'css', value: 'form' },
        child: { kind: 'frame', selector: '#f', index: 0, child: label('Deep field') },
      })
    ).toBe('deepField');
  });

  it('drops filler words, leading numbers and keeps at most four words', () => {
    expect(nameFor({ kind: 'placeholder', value: 'Enter your email address' })).toBe('emailAddress');
    expect(nameFor(label('Select a country'))).toBe('country');
    expect(nameFor(label('2nd address line'))).toBe('addressLine');
    expect(nameFor(label('Gift wrap this order (+ £3.50)'))).toBe('giftWrapThisOrder');
    expect(nameFor(label('ZIP code'))).toBe('zipCode');
    expect(nameFor(label('Prénom'))).toBe('prenom');
    expect(nameFor(label('x'.repeat(50)))).toBe('x'.repeat(40));
  });

  it('keeps a filler word when it is the only word, renaming it if reserved', () => {
    expect(nameFor(label('Type'))).toBe('typeValue');
    expect(nameFor(label('Your'))).toBe('your');
  });

  it('falls back to the input type, then to the action', () => {
    expect(nameFor({ kind: 'placeholder', value: '+44 20 7946 0000' }, { inputType: 'tel' })).toBe('phone');
    expect(nameFor({ kind: 'css', value: 'input.e' }, { inputType: 'email' })).toBe('email');
    expect(nameFor({ kind: 'css', value: 'input' }, { inputType: 'number' })).toBe('numberValue');
    expect(nameFor({ kind: 'css', value: 'input' }, { inputType: 'datetime-local' })).toBe('dateTime');
    expect(nameFor({ kind: 'role', role: 'textbox' })).toBe('inputValue');
    expect(nameFor(label('名前'))).toBe('inputValue');
    expect(nameFor({ kind: 'css', value: 'input' }, { inputType: 'toString' })).toBe('inputValue');
    expect(I.deriveVariableName(select({ kind: 'css', value: 'select' }, 'x'))).toBe('selectedOption');
    expect(I.deriveVariableName()).toBe('inputValue');
    expect(I.deriveVariableName({ action: 'fill', target: { kind: 'chain' } })).toBe('inputValue');
  });

  it('never derives a word reserved in JS/TS, Python, Java or C#', () => {
    expect(nameFor(label('Class'))).toBe('classValue');
    expect(nameFor(label('Default'))).toBe('defaultValue');
    expect(nameFor(label('Lambda'))).toBe('lambdaValue');
    expect(nameFor(label('Synchronized'))).toBe('synchronizedValue');
    expect(nameFor(label('Delegate'))).toBe('delegateValue');
    expect(nameFor(label('String'))).toBe('stringValue');
    expect(nameFor(label('Constructor'))).toBe('constructorValue');
  });

  it('only ever derives valid, non-reserved names', () => {
    const samples = [
      '',
      ' ',
      '___',
      '123',
      'a1',
      '9 lives',
      'İstanbul',
      'emoji 🎉 field',
      'AND OR NOT',
      'if else',
      'new',
      'in',
      'NaN',
      'Ünïcödé',
      'x-y_z.w',
      'HTMLParser',
      'iPhone model',
    ];
    for (const s of samples) {
      for (const t of [label(s), id(s), { kind: 'role', role: 'textbox', name: s }]) {
        const n = nameFor(t);
        expect(C.isValidVariableName(n), `${JSON.stringify(s)} → ${n}`).toBe(true);
        expect(I.VAR_RESERVED).not.toContain(n);
      }
    }
  });

  it('reserves every keyword of the supported languages', () => {
    for (const w of [
      'await',
      'yield',
      'None',
      'True',
      'match',
      'record',
      'goto',
      'foreach',
      'out',
      '__proto__',
    ])
      expect(I.VAR_RESERVED).toContain(w);
  });
});

describe('isValidVariableName / validateVariableName / variableKey', () => {
  it('accepts identifiers that are legal and not reserved everywhere', () => {
    for (const n of ['a', 'firstName', '_x', 'x_1', 'A'.repeat(64)])
      expect(C.isValidVariableName(n), n).toBe(true);
    for (const n of [
      '',
      '1a',
      'a-b',
      'a b',
      'é',
      '$a',
      'A'.repeat(65),
      'class',
      'None',
      '_',
      null,
      undefined,
      3,
    ])
      expect(C.isValidVariableName(n), String(n)).toBe(false);
  });

  it('explains why a name cannot be used', () => {
    expect(C.validateVariableName('')).toBe('Enter a name.');
    expect(C.validateVariableName(null)).toBe('Enter a name.');
    expect(C.validateVariableName('a'.repeat(65))).toBe('Use at most 64 characters.');
    expect(C.validateVariableName('1st')).toBe(
      'Use letters, digits and _ only, starting with a letter or _.'
    );
    expect(C.validateVariableName('try')).toBe('"try" is a reserved word in generated code.');
    expect(C.validateVariableName('email', ['name', 'email'])).toBe(
      'Another variable is already named "email".'
    );
    expect(C.validateVariableName('first_name', [7, 'firstName'])).toBe(
      'Clashes with "firstName": both are "first_name" in Python.'
    );
    expect(C.validateVariableName('email', ['name', 'phone'])).toBeNull();
    expect(C.validateVariableName('email', 'not-a-list')).toBeNull();
  });

  it('maps a name to its key per language (Python: snake_case)', () => {
    expect(C.variableKey('firstName', 'python')).toBe('first_name');
    expect(C.variableKey('HTMLParser', 'python')).toBe('html_parser');
    expect(C.variableKey('address2Line', 'python')).toBe('address2_line');
    expect(C.variableKey('email2', 'python')).toBe('email2');
    expect(C.variableKey('__', 'python')).toBe('__');
    expect(C.variableKey('firstName', 'typescript')).toBe('firstName');
    expect(C.variableKey('firstName', 'java')).toBe('firstName');
  });
});

// ── applying ────────────────────────────────────────────────────────────────────

describe('applyVariables', () => {
  const steps = () => [
    { eventId: 'g', action: 'goto', value: URL },
    fill(label('First name'), 'Ada', { eventId: 'f1' }),
    select(id('country'), 'Ireland', { eventId: 's1' }),
    fill(label('First name'), 'Ada', { eventId: 'f2' }),
  ];

  it('returns new shallow copies, setting varRef on the steps of each variable', () => {
    const input = steps();
    const before = JSON.stringify(input);
    const out = C.applyVariables(input, C.extractVariables(input));
    expect(out).not.toBe(input);
    expect(out.map((s) => s.varRef)).toEqual([undefined, 'firstName', 'country', 'firstName']);
    expect(out[1]).not.toBe(input[1]);
    expect(out[1].target).toBe(input[1].target); // shallow
    expect(JSON.stringify(input)).toBe(before);
    expect('varRef' in out[0]).toBe(false);
  });

  it('matches steps without an eventId by their index', () => {
    const input = [{ action: 'goto', value: URL }, fill(label('Name'), 'Ada'), fill(label('Name'), 'Bo')];
    const vars = C.extractVariables(input);
    expect(C.applyVariables(input, vars).map((s) => s.varRef)).toEqual([undefined, 'name', 'name2']);
    // eventIds win over positions: a step with an id is never matched by index.
    const withId = [{ action: 'goto' }, fill(label('Name'), 'Ada', { eventId: 'x' })];
    expect(
      C.applyVariables(withId, [{ name: 'name', value: 'Ada', eventIds: [], indexes: [1] }])[1].varRef
    ).toBe(undefined);
  });

  it('matches eventIds as strings', () => {
    const out = C.applyVariables(
      [fill(label('A'), 'v', { eventId: 7 })],
      [{ name: 'a', value: 'v', eventIds: ['7'] }]
    );
    expect(out[0].varRef).toBe('a');
  });

  it('only references a variable whose value still equals the step value', () => {
    const input = steps();
    const vars = C.extractVariables(input);
    input[3] = { ...input[3], value: 'Grace' };
    expect(C.applyVariables(input, vars).map((s) => s.varRef)).toEqual([
      undefined,
      'firstName',
      'country',
      undefined,
    ]);
  });

  it('never references a sensitive or ineligible step, and drops stale references', () => {
    const input = [
      fill(label('Password'), 'pw', { eventId: 'p', sensitive: true, varRef: 'pw' }),
      { action: 'click', target: id('x'), eventId: 'c', varRef: 'x' },
      fill(label('A'), 'v', { eventId: 'a', varRef: 'old' }),
    ];
    const vars = [
      { name: 'pw', value: 'pw', eventIds: ['p'] },
      { name: 'x', value: '', eventIds: ['c'] },
    ];
    const out = C.applyVariables(input, vars);
    expect(out.map((s) => s.varRef)).toEqual([undefined, undefined, undefined]);
    expect(input[2].varRef).toBe('old');
  });

  it('copies own properties only, and lets the first variable claim an index', () => {
    const step = Object.assign(Object.create({ inherited: true }), fill(label('A'), 'v'));
    const vars = [
      { name: 'first', value: 'v', indexes: [0] },
      { name: 'second', value: 'v', indexes: [0] },
    ];
    const [out] = C.applyVariables([step], vars);
    expect(out.varRef).toBe('first');
    expect('inherited' in out).toBe(false);
    expect(out.value).toBe('v');
  });

  it('ignores malformed variables and passes non-object steps through', () => {
    const input = [
      null,
      'x',
      fill(label('A'), 'v', { eventId: 'a' }),
      fill(label('B'), 'w', { eventId: 'b' }),
    ];
    const vars = [
      null,
      { name: 'class', value: 'v', eventIds: ['a'] },
      { name: 'ok', value: 5, eventIds: ['a'] },
      { name: 'b', value: 'w', eventIds: 'b', indexes: 'x' },
      { name: 'first', value: 'v', eventIds: ['a'] },
      { name: 'second', value: 'v', eventIds: ['a'], indexes: [2] },
    ];
    const out = C.applyVariables(input, vars);
    expect(out[0]).toBe(null);
    expect(out[1]).toBe('x');
    expect(out[2].varRef).toBe('first');
    expect(out[3].varRef).toBe(undefined);
    expect(C.applyVariables(undefined, vars)).toEqual([]);
    expect(C.applyVariables(input, undefined).map((s) => s && s.varRef)).toEqual([
      null,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

// ── JSON ────────────────────────────────────────────────────────────────────────

describe('variablesJson', () => {
  it('renders pretty JSON in variable order', () => {
    expect(
      C.variablesJson([
        { name: 'firstName', value: 'Ada' },
        { name: 'country', value: 'Ireland' },
      ])
    ).toBe('{\n  "firstName": "Ada",\n  "country": "Ireland"\n}\n');
  });

  it('round-trips awkward values exactly', () => {
    const value = 'q"uote\' back\\slash\nnew line \u0000 🎉 ${x} {enter}';
    expect(JSON.parse(C.variablesJson([{ name: 'v', value }]))).toEqual({ v: value });
  });

  it('writes a missing value as an empty string', () => {
    expect(C.variablesJson([{ name: 'a' }, { name: 'b', value: null }])).toBe(
      '{\n  "a": "",\n  "b": ""\n}\n'
    );
  });

  it('is {} with nothing to show, and skips invalid or repeated names', () => {
    expect(C.variablesJson([])).toBe('{}\n');
    expect(C.variablesJson()).toBe('{}\n');
    expect(
      C.variablesJson([
        { name: '__proto__', value: 'x' },
        { name: 'a', value: 1 },
        { name: 'a', value: 'dup' },
        null,
      ])
    ).toBe('{\n  "a": "1"\n}\n');
  });
});

// ── rendering ───────────────────────────────────────────────────────────────────

const FLOW = [
  { eventId: 'e1', action: 'goto', value: URL, url: URL },
  fill(testid('first-name'), 'Ada', { eventId: 'e2' }),
  select(id('country'), 'Ireland', { eventId: 'e3' }),
  fill(id('password'), '', { eventId: 'e4', sensitive: true, secretName: 'LOCATRA_PASSWORD' }),
  fill({ kind: 'name', value: 'last_name' }, "O'Brien", { eventId: 'e5' }),
  fill(testid('first-name'), 'Ada', { eventId: 'e6' }),
  {
    eventId: 'e7',
    action: 'assert',
    assertType: 'toHaveValue',
    value: 'Ada',
    url: URL,
    target: testid('first-name'),
  },
];

const PW_JS = [
  "import { test, expect } from '@playwright/test';",
  '',
  'const testData = {',
  "  firstName: 'Ada',",
  "  country: 'Ireland',",
  "  lastName: 'O\\'Brien',",
  '};',
  '',
  "test('recorded test', async ({ page }) => {",
  "  await page.goto('https://shop.example/checkout');",
  "  await page.getByTestId('first-name').fill(testData.firstName);",
  "  await page.locator('#country').selectOption(testData.country);",
  "  await page.locator('#password').fill(process.env.LOCATRA_PASSWORD ?? '');",
  '  await page.locator(\'[name="last_name"]\').fill(testData.lastName);',
  "  await page.getByTestId('first-name').fill(testData.firstName);",
  "  await expect(page.getByTestId('first-name')).toHaveValue('Ada');",
  '});',
  '',
].join('\n');

const PW_PY = [
  'import os',
  'from playwright.sync_api import Page, expect',
  '',
  '',
  'TEST_DATA = {',
  '    "first_name": "Ada",',
  '    "country": "Ireland",',
  '    "last_name": "O\'Brien",',
  '}',
  '',
  '',
  'def test_recorded(page: Page):',
  '    page.goto("https://shop.example/checkout")',
  '    page.get_by_test_id("first-name").fill(TEST_DATA["first_name"])',
  '    page.locator("#country").select_option(TEST_DATA["country"])',
  '    page.locator("#password").fill(os.environ.get("LOCATRA_PASSWORD", ""))',
  '    page.locator("[name=\\"last_name\\"]").fill(TEST_DATA["last_name"])',
  '    page.get_by_test_id("first-name").fill(TEST_DATA["first_name"])',
  '    expect(page.get_by_test_id("first-name")).to_have_value("Ada")',
  '',
].join('\n');

const SEL_JS = [
  "const { Builder, By, Key, Select } = require('selenium-webdriver');",
  "const assert = require('assert');",
  '',
  'const testData = {',
  "  firstName: 'Ada',",
  "  country: 'Ireland',",
  "  lastName: 'O\\'Brien',",
  '};',
  '',
  '(async () => {',
  "  const driver = await new Builder().forBrowser('chrome').build();",
  '  await driver.manage().setTimeouts({ implicit: 10000 }); // Selenium has no auto-wait',
  '  try {',
  "    await driver.get('https://shop.example/checkout');",
  '    {',
  '      const el = driver.findElement(By.css(\'[data-testid="first-name"]\'));',
  '      await el.clear();',
  '      await el.sendKeys(testData.firstName);',
  '    }',
  "    await new Select(driver.findElement(By.id('country'))).selectByVisibleText(testData.country);",
  '    {',
  "      const el = driver.findElement(By.id('password'));",
  '      await el.clear();',
  "      await el.sendKeys(process.env.LOCATRA_PASSWORD ?? '');",
  '    }',
  '    {',
  "      const el = driver.findElement(By.name('last_name'));",
  '      await el.clear();',
  '      await el.sendKeys(testData.lastName);',
  '    }',
  '    {',
  '      const el = driver.findElement(By.css(\'[data-testid="first-name"]\'));',
  '      await el.clear();',
  '      await el.sendKeys(testData.firstName);',
  '    }',
  "    assert.strictEqual(await driver.findElement(By.css('[data-testid=\"first-name\"]')).getAttribute('value'), 'Ada');",
  '  } finally {',
  '    await driver.quit();',
  '  }',
  '})();',
  '',
].join('\n');

const SEL_PY = [
  'import os',
  'from selenium import webdriver',
  'from selenium.webdriver.common.by import By',
  'from selenium.webdriver.support.ui import Select',
  '',
  '',
  'TEST_DATA = {',
  '    "first_name": "Ada",',
  '    "country": "Ireland",',
  '    "last_name": "O\'Brien",',
  '}',
  '',
  'driver = webdriver.Chrome()',
  'driver.implicitly_wait(10)  # Selenium has no auto-wait; give elements time to appear',
  'try:',
  '    driver.get("https://shop.example/checkout")',
  '    el = driver.find_element(By.CSS_SELECTOR, "[data-testid=\\"first-name\\"]")',
  '    el.clear()',
  '    el.send_keys(TEST_DATA["first_name"])',
  '    Select(driver.find_element(By.ID, "country")).select_by_visible_text(TEST_DATA["country"])',
  '    el = driver.find_element(By.ID, "password")',
  '    el.clear()',
  '    el.send_keys(os.environ.get("LOCATRA_PASSWORD", ""))',
  '    el = driver.find_element(By.NAME, "last_name")',
  '    el.clear()',
  '    el.send_keys(TEST_DATA["last_name"])',
  '    el = driver.find_element(By.CSS_SELECTOR, "[data-testid=\\"first-name\\"]")',
  '    el.clear()',
  '    el.send_keys(TEST_DATA["first_name"])',
  '    assert driver.find_element(By.CSS_SELECTOR, "[data-testid=\\"first-name\\"]").get_attribute("value") == "Ada"',
  'finally:',
  '    driver.quit()',
  '',
].join('\n');

const CY_DECL =
  "const testData = {\n  firstName: 'Ada',\n  country: 'Ireland',\n  lastName: 'O\\'Brien',\n};\n\n";

describe('rendering in every framework × language', () => {
  it('Playwright TypeScript / JavaScript', () => {
    expect(C.testScript(FLOW, 'playwright', 'typescript', { variables: true })).toBe(PW_JS);
    expect(C.testScript(FLOW, 'playwright', 'javascript', { variables: true })).toBe(PW_JS);
  });

  it('Playwright Python', () => {
    expect(C.testScript(FLOW, 'playwright', 'python', { variables: true })).toBe(PW_PY);
  });

  it('Selenium TypeScript / JavaScript', () => {
    expect(C.testScript(FLOW, 'selenium', 'typescript', { variables: true })).toBe(SEL_JS);
    expect(C.testScript(FLOW, 'selenium', 'javascript', { variables: true })).toBe(SEL_JS);
  });

  it('Selenium Python', () => {
    expect(C.testScript(FLOW, 'selenium', 'python', { variables: true })).toBe(SEL_PY);
  });

  it('Cypress TypeScript / JavaScript: declaration first, references in the statements', () => {
    for (const lang of ['typescript', 'javascript']) {
      const literal = C.testScript(FLOW, 'cypress', lang);
      const expected = (CY_DECL + literal)
        .replace(
          "cy.get('[data-testid=\"first-name\"]').clear().type('Ada', { parseSpecialCharSequences: false });",
          'cy.get(\'[data-testid="first-name"]\').clear().type(testData.firstName, { parseSpecialCharSequences: false });'
        )
        .replace(
          "cy.get('[data-testid=\"first-name\"]').clear().type('Ada', { parseSpecialCharSequences: false });",
          'cy.get(\'[data-testid="first-name"]\').clear().type(testData.firstName, { parseSpecialCharSequences: false });'
        )
        .replace("cy.get('#country').select('Ireland');", "cy.get('#country').select(testData.country);")
        .replace(
          "cy.get('[name=\"last_name\"]').clear().type('O\\'Brien', { parseSpecialCharSequences: false });",
          'cy.get(\'[name="last_name"]\').clear().type(testData.lastName, { parseSpecialCharSequences: false });'
        );
      const got = C.testScript(FLOW, 'cypress', lang, { variables: true });
      expect(got).toBe(expected);
      expect(got.startsWith(CY_DECL + '// Locatra: read a secret')).toBe(true);
      expect(got).toContain("cy.get('[data-testid=\"first-name\"]').should('have.value', 'Ada');");
    }
  });

  it('Cypress passes the test data into every cy.origin() block', () => {
    const B = 'https://pay.example/card';
    const steps = [
      { eventId: 'o1', action: 'goto', value: URL, url: URL },
      fill(id('name'), 'Ada', { eventId: 'o2' }),
      { eventId: 'o3', action: 'goto', value: B, url: B },
      fill(id('card'), '4242', { eventId: 'o4', url: B }),
      { eventId: 'o5', action: 'click', target: id('pay'), url: B },
      { eventId: 'o6', action: 'goto', value: 'https://help.example/', url: 'https://help.example/' },
      { eventId: 'o7', action: 'click', target: id('faq'), url: 'https://help.example/' },
    ];
    const expected = [
      'const testData = {',
      "  name: 'Ada',",
      "  card: '4242',",
      '};',
      '',
      "describe('recorded test', () => {",
      "  it('replays the recorded flow', () => {",
      "    cy.visit('https://shop.example/checkout');",
      "    cy.get('#name').clear().type(testData.name, { parseSpecialCharSequences: false });",
      "    cy.origin('https://pay.example', { args: { testData } }, ({ testData }) => {",
      "      cy.visit('https://pay.example/card');",
      "      cy.get('#card').clear().type(testData.card, { parseSpecialCharSequences: false });",
      "      cy.get('#pay').click();",
      '    });',
      "    cy.origin('https://help.example', { args: { testData } }, ({ testData }) => {",
      "      cy.visit('https://help.example/');",
      "      cy.get('#faq').click();",
      '    });',
      '  });',
      '});',
      '',
    ].join('\n');
    expect(C.testScript(steps, 'cypress', 'typescript', { variables: true })).toBe(expected);
    expect(C.testScript(steps, 'cypress', 'javascript', { variables: true })).toBe(expected);
    // Without variables the blocks take no arguments, exactly as before.
    expect(C.testScript(steps, 'cypress', 'javascript')).toContain(
      "cy.origin('https://pay.example', () => {"
    );
  });

  it('places the declaration after the cypress-real-events import and before the helpers', () => {
    const steps = [
      fill(label('First name'), 'Ada', { eventId: '1' }),
      { action: 'press', value: 'Shift+Tab' },
    ];
    const out = C.testScript(steps, 'cypress', 'typescript', { variables: true });
    expect(out).toContain(
      "import 'cypress-real-events';\n\nconst testData = {\n  firstName: 'Ada',\n};\n\n// Locatra helper (generated)"
    );
  });

  it('references test data in the set-value paths for range / colour / date inputs', () => {
    const step = fill(id('vol'), '50', { inputType: 'range', varRef: 'volume' });
    expect(C.actionStatement(step, 'selenium', 'javascript')).toBe(
      `await driver.executeScript(LOCATRA_SET_VALUE_JS, driver.findElement(By.id('vol')), testData.volume);`
    );
    expect(C.actionStatement(step, 'selenium', 'python')).toBe(
      `driver.execute_script(LOCATRA_SET_VALUE_JS, driver.find_element(By.ID, "vol"), TEST_DATA["volume"])`
    );
    expect(C.actionStatement(step, 'cypress', 'javascript')).toBe(
      "cy.get('#vol').invoke('val', testData.volume).trigger('input').trigger('change');"
    );
    expect(C.actionStatement(step, 'playwright', 'python')).toBe(
      'page.locator("#vol").fill(TEST_DATA["volume"])'
    );
  });

  it('renders select references in every built-in language', () => {
    const step = select(id('plan'), 'Pro', { varRef: 'plan' });
    expect(C.actionStatement(step, 'playwright', 'typescript')).toBe(
      "await page.locator('#plan').selectOption(testData.plan);"
    );
    expect(C.actionStatement(step, 'playwright', 'python')).toBe(
      'page.locator("#plan").select_option(TEST_DATA["plan"])'
    );
    expect(C.actionStatement(step, 'selenium', 'javascript')).toBe(
      "await new Select(driver.findElement(By.id('plan'))).selectByVisibleText(testData.plan);"
    );
    expect(C.actionStatement(step, 'selenium', 'python')).toBe(
      'Select(driver.find_element(By.ID, "plan")).select_by_visible_text(TEST_DATA["plan"])'
    );
    expect(C.actionStatement(step, 'cypress', 'typescript')).toBe("cy.get('#plan').select(testData.plan);");
  });

  it('keeps sensitive values as environment variables even with a varRef', () => {
    const step = fill(id('pw'), 'x', { sensitive: true, secretName: 'MY_SECRET', varRef: 'pw' });
    expect(C.actionStatement(step, 'playwright', 'typescript')).toBe(
      "await page.locator('#pw').fill(process.env.MY_SECRET ?? '');"
    );
    expect(C.actionStatement(step, 'playwright', 'python')).toBe(
      'page.locator("#pw").fill(os.environ.get("MY_SECRET", ""))'
    );
    for (const [fw, lang] of COMBOS) {
      const out = C.testScript([{ ...step, eventId: 'p' }], fw, lang, {
        variables: [{ name: 'pw', value: 'x', eventIds: ['p'] }],
      });
      expect(out, `${fw}/${lang}`).not.toMatch(/testData\.pw|TEST_DATA\["pw"\]/);
    }
  });

  it('renders a literal for an invalid varRef and for non-fill steps', () => {
    expect(C.actionStatement(fill(id('a'), 'v', { varRef: 'class' }), 'playwright', 'javascript')).toBe(
      "await page.locator('#a').fill('v');"
    );
    expect(C.actionStatement(fill(id('a'), 'v', { varRef: 'a-b' }), 'cypress', 'javascript')).toBe(
      "cy.get('#a').clear().type('v', { parseSpecialCharSequences: false });"
    );
    const assertion = {
      action: 'assert',
      assertType: 'toHaveValue',
      target: id('a'),
      value: 'v',
      varRef: 'a',
    };
    expect(C.actionStatement(assertion, 'playwright', 'javascript')).toBe(
      "await expect(page.locator('#a')).toHaveValue('v');"
    );
  });

  it('clears instead of typing an empty Cypress value, even with a reference', () => {
    expect(C.actionStatement(fill(id('a'), '', { varRef: 'a' }), 'cypress', 'javascript')).toBe(
      "cy.get('#a').clear();"
    );
  });
});

// ── testScript / wrapScript options ────────────────────────────────────────────

describe('testScript and wrapScript options', () => {
  it('is byte-identical to the literal script without variables, false or with nothing to extract', () => {
    const noValues = FLOW.filter((s) => s.action !== 'fill' && s.action !== 'selectOption');
    for (const [fw, lang] of COMBOS) {
      const literal = C.testScript(FLOW, fw, lang);
      expect(C.testScript(FLOW, fw, lang, {}), `${fw}/${lang}`).toBe(literal);
      expect(C.testScript(FLOW, fw, lang, { variables: false }), `${fw}/${lang}`).toBe(literal);
      expect(C.testScript(FLOW, fw, lang, { variables: [] }), `${fw}/${lang}`).toBe(literal);
      expect(C.testScript(noValues, fw, lang, { variables: true }), `${fw}/${lang}`).toBe(
        C.testScript(noValues, fw, lang)
      );
      expect(C.wrapScript(['x'], fw, lang, null, { variables: [] })).toBe(C.wrapScript(['x'], fw, lang));
    }
  });

  it('drops references a caller left on the steps when variables are off', () => {
    const stale = FLOW.map((s) => (s.action === 'fill' && !s.sensitive ? { ...s, varRef: 'old' } : s));
    for (const [fw, lang] of COMBOS) {
      expect(C.testScript(stale, fw, lang), `${fw}/${lang}`).toBe(C.testScript(FLOW, fw, lang));
      expect(C.testScript(stale, fw, lang, { variables: false }), `${fw}/${lang}`).toBe(
        C.testScript(FLOW, fw, lang)
      );
    }
  });

  it('uses an edited variable list as-is', () => {
    const vars = C.extractVariables(FLOW);
    vars[0] = { ...vars[0], name: 'customer' };
    const out = C.testScript(FLOW, 'playwright', 'javascript', { variables: vars, extra: 1 });
    expect(out).toContain(
      "const testData = {\n  customer: 'Ada',\n  country: 'Ireland',\n  lastName: 'O\\'Brien',\n};"
    );
    expect(out).toContain("getByTestId('first-name').fill(testData.customer);");
    expect(out).not.toContain('firstName');
  });

  it('applies variables before dropping suggested steps, so index matches line up', () => {
    const steps = [
      { action: 'assert', assertType: 'toBeVisible', target: id('banner'), suggested: true },
      fill(label('Name'), 'Ada'),
    ];
    const vars = C.extractVariables(steps);
    expect(vars).toEqual([{ name: 'name', value: 'Ada', kind: 'fill', eventIds: [], indexes: [1] }]);
    expect(C.testScript(steps, 'playwright', 'javascript', { variables: vars })).toContain(
      "await page.getByLabel('Name').fill(testData.name);"
    );
    expect(C.testScript(steps, 'playwright', 'javascript', { variables: true })).not.toContain('banner');
  });

  it('declares a referenced variable the list lacks, and ignores invalid or repeated entries', () => {
    const stmts = [
      "await page.locator('#a').fill(testData.a);",
      "await page.locator('#b').fill(testData.b);",
    ];
    const steps = [fill(id('a'), 'A', { varRef: 'a' }), fill(id('b'), 'B', { varRef: 'b' })];
    const vars = [
      { name: 'b', value: 'from list' },
      { name: 'b', value: 'dup' },
      { name: 'if', value: 'x' },
      null,
    ];
    expect(C.wrapScript(stmts, 'playwright', 'javascript', steps, { variables: vars })).toBe(
      "import { test, expect } from '@playwright/test';\n\n" +
        "const testData = {\n  b: 'from list',\n  a: 'A',\n};\n\n" +
        "test('recorded test', async ({ page }) => {\n" +
        "  await page.locator('#a').fill(testData.a);\n  await page.locator('#b').fill(testData.b);\n});\n"
    );
    // Even with no options at all, references never point at an undeclared name.
    expect(C.wrapScript(stmts, 'playwright', 'javascript', steps)).toContain(
      "const testData = {\n  a: 'A',\n  b: 'B',\n};"
    );
  });

  it('builds the panel flow (apply → actionStatement → wrapScript) to the same script as testScript', () => {
    for (const [fw, lang] of COMBOS) {
      const vars = C.extractVariables(FLOW);
      const applied = C.applyVariables(FLOW, vars);
      const stmts = applied.map((s) => C.actionStatement(s, fw, lang));
      expect(C.wrapScript(stmts, fw, lang, applied, { variables: vars }), `${fw}/${lang}`).toBe(
        C.testScript(FLOW, fw, lang, { variables: true })
      );
    }
  });

  it('declares exactly the keys the statements reference, in every language', () => {
    const steps = [
      fill(label('First name'), 'Ada', { eventId: '1' }),
      fill(label('First name'), 'Grace', { eventId: '2' }),
      select(label('HTTP Method'), 'POST', { eventId: '3' }),
      fill(label('Address 2 line'), 'Flat 4', { eventId: '4' }),
    ];
    for (const [fw, lang] of COMBOS) {
      const out = C.testScript(steps, fw, lang, { variables: true });
      if (lang === 'python') {
        const declared = [...out.matchAll(/^ {4}"(\w+)": /gm)].map((m) => m[1]);
        const used = [...out.matchAll(/TEST_DATA\["(\w+)"\]/g)].map((m) => m[1]);
        expect(declared).toEqual(['first_name', 'first_name2', 'http_method', 'address2_line']);
        expect([...new Set(used)].sort()).toEqual([...declared].sort());
      } else {
        const declared = [...out.matchAll(/^ {2}(\w+): '/gm)].map((m) => m[1]);
        const used = [...out.matchAll(/testData\.(\w+)/g)].map((m) => m[1]);
        expect(declared, `${fw}/${lang}`).toEqual(['firstName', 'firstName2', 'httpMethod', 'address2Line']);
        expect([...new Set(used)].sort(), `${fw}/${lang}`).toEqual([...declared].sort());
      }
    }
  });
});

// ── the generated code runs ────────────────────────────────────────────────────

const AWKWARD = [
  'q"uote\' mixed',
  'back\\slash \\n not-a-newline',
  'line\nbreak\ttab\r',
  'nul\u0000 del\u007f sep  ',
  'emoji 🎉 ünïcödé 名前',
  '${notATemplate} {enter} {{x}} %s',
  '</script><!--',
];

function awkwardSteps() {
  const steps = [{ eventId: 'g', action: 'goto', value: URL, url: URL }];
  AWKWARD.forEach((v, i) => steps.push(fill(label(`Field ${i}`), v, { eventId: `f${i}` })));
  steps.push(select(label('Choice'), 'Ü "1"', { eventId: 'sel' }));
  steps.push(fill(id('pw'), '', { eventId: 'pw', sensitive: true }));
  return steps;
}

describe('generated scripts', () => {
  it('parse in every language', () => {
    const steps = awkwardSteps();
    for (const [fw, lang] of COMBOS) {
      const code = C.testScript(steps, fw, lang, { variables: true });
      if (lang === 'python') {
        if (!python) continue;
        const file = join(dir, `${fw}.py`);
        writeFileSync(file, code);
        expect(
          () =>
            execFileSync(
              'python3',
              ['-I', '-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', file],
              {
                stdio: 'pipe',
              }
            ),
          `${fw}/${lang}`
        ).not.toThrow();
        continue;
      }
      // Selenium scaffolds are CommonJS (require); Playwright and Cypress specs are modules.
      const file = join(dir, `${fw}-${lang}.${fw === 'selenium' ? 'cjs' : 'mjs'}`);
      writeFileSync(file, lang === 'typescript' ? stripTypeScriptTypes(code) : code);
      expect(
        () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
        `${fw}/${lang}`
      ).not.toThrow();
    }
  });

  it('declare every value exactly as typed (JS/TS evaluated, Python executed)', () => {
    const steps = awkwardSteps();
    const vars = C.extractVariables(steps);
    const want = Object.fromEntries(vars.map((v) => [v.name, v.value]));
    expect(Object.values(want)).toEqual([...AWKWARD, 'Ü "1"']);
    for (const [fw, lang] of COMBOS) {
      const code = C.testScript(steps, fw, lang, { variables: true });
      if (lang === 'python') {
        if (!python) continue;
        const decl = /^TEST_DATA = \{\n[\s\S]*?\n\}$/m.exec(code)[0];
        const file = join(dir, `decl-${fw}.py`);
        writeFileSync(file, decl + '\nimport json, sys\nsys.stdout.write(json.dumps(TEST_DATA))\n');
        const got = JSON.parse(execFileSync('python3', ['-I', file], { encoding: 'utf8' }));
        expect(got, `${fw}/${lang}`).toEqual(
          Object.fromEntries(vars.map((v) => [C.variableKey(v.name, 'python'), v.value]))
        );
        continue;
      }
      const decl = /^const testData = \{\n[\s\S]*?\n\};$/m.exec(code)[0];
      const got = vm.runInNewContext(decl.replace('const testData =', 'out =') + '\nout', { out: null });
      expect(JSON.parse(JSON.stringify(got)), `${fw}/${lang}`).toEqual(want);
    }
  });

  it('run against stand-ins, passing the declared values to fill / selectOption', async () => {
    // Playwright JS: run the spec body with a recording page and check what fill() got.
    const steps = awkwardSteps();
    const code = C.testScript(steps, 'playwright', 'javascript', { variables: true });
    const calls = [];
    const locator = (sel) => ({
      fill: async (v) => calls.push(['fill', sel, v]),
      selectOption: async (v) => calls.push(['select', sel, v]),
    });
    const page = {
      goto: async () => {},
      getByLabel: (l) => locator(l),
      locator: (l) => locator(l),
    };
    let body;
    vm.runInNewContext(code.replace("import { test, expect } from '@playwright/test';", ''), {
      process: { env: { LOCATRA_PASSWORD: 'pw!' } },
      test: (name, fn) => {
        body = fn;
      },
    });
    await body({ page });
    expect(calls).toEqual([
      ...AWKWARD.map((v, i) => ['fill', `Field ${i}`, v]),
      ['select', 'Choice', 'Ü "1"'],
      ['fill', '#pw', 'pw!'],
    ]);
  });
});

// ── plug-in targets ─────────────────────────────────────────────────────────────

describe('registered targets', () => {
  it('receive references on the step and the normalised variables in wrapScript', () => {
    const seen = {};
    C.registerTarget({
      framework: { id: 'vartest', label: 'VarTest' },
      languages: [{ id: 'vlang', label: 'VLang', ext: '.v' }],
      locatorExpr: () => 'loc',
      actionStatement: (step) => `stmt(${I.variableRefName(step) || 'literal'})`,
      wrapScript: (stmts, lang, steps, opts) => {
        seen.opts = opts;
        return stmts.join('\n');
      },
      pageObject: () => '',
    });
    const out = C.testScript(FLOW, 'vartest', 'vlang', { variables: true, keep: 'me' });
    expect(out.split('\n')).toEqual([
      'stmt(literal)',
      'stmt(firstName)',
      'stmt(country)',
      'stmt(literal)',
      'stmt(lastName)',
      'stmt(firstName)',
      'stmt(literal)',
    ]);
    expect(seen.opts).toEqual({
      keep: 'me',
      variables: [
        { name: 'firstName', value: 'Ada' },
        { name: 'country', value: 'Ireland' },
        { name: 'lastName', value: "O'Brien" },
      ],
    });
    C.testScript(FLOW, 'vartest', 'vlang');
    expect(seen.opts).toBeUndefined();
    // Only the caller's own option fields are passed on.
    C.testScript(
      FLOW,
      'vartest',
      'vlang',
      Object.assign(Object.create({ inherited: 1 }), { variables: true })
    );
    expect(Object.keys(seen.opts)).toEqual(['variables']);
    C.wrapScript(['x'], 'vartest', 'vlang', [], Object.assign(Object.create({ inherited: 1 }), { own: 2 }));
    expect(seen.opts).toEqual({ own: 2 });
    C.testScript(FLOW, 'vartest', 'vlang', { variables: false, keep: 1 });
    expect(seen.opts).toEqual({ keep: 1 });
    C.wrapScript(['x'], 'vartest', 'vlang', [fill(id('a'), 'A', { varRef: 'a' })]);
    expect(seen.opts).toEqual({ variables: [{ name: 'a', value: 'A' }] });
  });

  it('share the name rules and declarations through _internals', () => {
    expect(I.variableRef('firstName', 'python')).toBe('TEST_DATA["first_name"]');
    expect(I.variableRef('firstName', 'typescript')).toBe('testData.firstName');
    expect(I.variablesDeclaration([{ name: 'firstName', value: 'Ada' }], 'javascript')).toBe(
      "const testData = {\n  firstName: 'Ada',\n};"
    );
    expect(I.variablesDeclaration([{ name: 'firstName', value: 'Ada' }], 'python')).toBe(
      'TEST_DATA = {\n    "first_name": "Ada",\n}'
    );
    expect(I.variablesDeclaration([], 'python')).toBe('');
    expect(I.pyVarKey('firstName')).toBe('first_name');
    expect(I.scriptVariables([{ name: 'a', value: 'b' }], null)).toEqual([{ name: 'a', value: 'b' }]);
    expect(I.varEligible(fill(id('a'), 'v'))).toBe(true);
    expect(I.VAR_NAME_RE.test('a1')).toBe(true);
    expect(I.isValidVariableName('ok')).toBe(true);
    expect(I.variableKey('aB', 'python')).toBe('a_b');
    expect(I.variableRefName(fill(id('a'), 'v', { varRef: 'a' }))).toBe('a');
    expect(I.variableRefName(null)).toBe(null);
  });
});

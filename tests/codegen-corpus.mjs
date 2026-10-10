// The corpus every codegen budget and compile check renders (C9.4): every target
// kind, exact and not, quotes and unicode, long-ish names, chains, frames, nested
// frames, shadow DOM (deep too), every action, the page-level steps, and a page
// object holding every target.
export const LONG = 'Please enter the email address you used when you created your account';
export const HOSTILE = `Delete "row" it's — café 日本 😀 \\ back`;
export const NBSP = 'Add\u00a0to\u00a0cart\u00ad now';

export const role = (r, name, o = {}) => ({ kind: 'role', role: r, ...(name != null ? { name } : {}), ...o });
export const kind = (k, value, o = {}) => ({ kind: k, value, ...o });
export const chain = (parent, child) => ({ kind: 'chain', parent, child });
export const frame = (selector, child, o = {}) => ({ kind: 'frame', selector, index: 1, child, ...o });
export const shadow = (t, hosts = ['x-app', 'x-panel[data-k="p"]']) => ({
  ...t,
  shadowHosts: hosts,
  shadowCss: 'button.go',
});

export const LEAVES = [
  role('textbox', 'Username or Email'),
  role('button', 'Save', { exact: true }),
  role('checkbox'),
  role('row', null, { matchCount: 1 }),
  role('heading', 'Summary', { level: 2 }),
  role('heading', null, { level: 7, nth: 3 }),
  role('button', HOSTILE),
  role('textbox', LONG, { exact: true }),
  role('button', NBSP),
  role('doc-tip', 'Unknown role'),
  kind('label', 'Email'),
  kind('label', LONG, { exact: true }),
  kind('label', HOSTILE),
  kind('text', 'Welcome back'),
  kind('text', HOSTILE, { exact: true }),
  kind('text', LONG),
  kind('placeholder', 'Search "all"'),
  kind('placeholder', LONG, { exact: true }),
  kind('altText', 'Company logo'),
  kind('title', 'Close dialog', { exact: true }),
  { kind: 'testid', attr: 'data-testid', value: 'place-order' },
  { kind: 'testid', attr: 'data:qa', value: HOSTILE },
  kind('id', 'username'),
  kind('id', 'md:w-1/2'),
  kind('name', 'q"1'),
  kind('css', 'form#checkout > fieldset.payment input[name="card-number"]:not([disabled])'),
  kind('xpath', '//button[normalize-space(.)="Save"]'),
  kind('xpath', 'id("main")/descendant::a[@aria-label="Close"]'),
];

export const TARGETS = [
  ...LEAVES,
  chain(kind('css', 'table.orders'), role('button', 'Delete')),
  chain(role('row', 'Ada Lovelace'), kind('text', 'Edit', { exact: true })),
  chain(kind('id', 'cart'), chain(role('listitem', 'Tea'), kind('label', 'Quantity'))),
  chain(kind('testid', 'x', { attr: 'data-testid' }), kind('xpath', '//td[2]')),
  frame('#payment', role('textbox', 'Card number')),
  frame(null, kind('label', 'Card holder')),
  frame('#outer', frame(null, kind('text', 'Pay now', { exact: true }))),
  frame(null, frame(null, role('button', HOSTILE))),
  frame('#shell iframe', kind('id', 'cvc'), { shadowPath: ['#shell', 'x-pay', 'iframe.card'] }),
  frame('#f', chain(kind('css', 'form.card'), role('button', 'Pay'))),
  shadow(role('button', 'Go')),
  shadow(kind('label', 'Email'), ['x-app']),
  shadow(kind('text', 'Deep'), ['x-app', 'x-shell[data-region="main"]', 'x-card.featured']),
  frame('#deep iframe', kind('id', 'cvc'), {
    shadowPath: ['#shell', 'x-pay', 'x-card[data-k="v"]', 'iframe.card'],
  }),
  { ...role('button', 'Go'), shadowHosts: ['x-app'] }, // no shadowCss: NOTE + own locator
  frame('#f', shadow(kind('text', 'Hi'))),
];

export const ACTIONS = [
  (t) => ({ action: 'click', target: t }),
  (t) => ({ action: 'dblclick', target: t }),
  (t) => ({ action: 'hover', target: t }),
  (t) => ({ action: 'check', target: t }),
  (t) => ({ action: 'uncheck', target: t }),
  (t) => ({ action: 'fill', target: t, value: HOSTILE }),
  (t) => ({ action: 'fill', target: t, value: '', sensitive: true, secretName: 'LOCATRA_PASSWORD' }),
  (t) => ({ action: 'fill', target: t, value: '42', inputType: 'range' }),
  (t) => ({ action: 'selectOption', target: t, value: 'Ireland' }),
  (t) => ({ action: 'selectOption', target: t, value: 'Red', values: ['Red', 'Green "lime"'] }),
  (t) => ({ action: 'upload', target: t, value: '["docs/cv.pdf","photo.png"]' }),
  (t) => ({ action: 'assert', assertType: 'toBeVisible', target: t }),
  (t) => ({ action: 'assert', assertType: 'toHaveText', target: t, value: LONG }),
  (t) => ({ action: 'assert', assertType: 'toContainText', target: t, value: 'Total' }),
  (t) => ({ action: 'assert', assertType: 'toHaveValue', target: t, value: 'ada@example.com' }),
  (t) => ({
    action: 'assert',
    assertType: 'toHaveValue',
    target: t,
    value: '',
    sensitive: true,
    secretName: 'PW',
  }),
  (t) => ({ action: 'assert', assertType: 'toBeChecked', target: t, value: 'false' }),
  (t) => ({ action: 'assert', assertType: 'toBeEnabled', target: t }),
];

export const PAGE_STEPS = [
  { action: 'goto', value: 'https://shop.example/checkout?step=2&ref=newsletter-campaign-2026' },
  { action: 'viewport', value: '1280x800' },
  { action: 'press', value: 'Control+Alt+Shift+Meta+Enter' },
  { action: 'press', value: 'Tab' },
  { action: 'assert', assertType: 'toHaveURL', value: 'https://shop.example/done?o=1' },
];

export const STEPS = [...PAGE_STEPS, ...TARGETS.flatMap((t) => ACTIONS.map((a) => a(t)))];

export const ELEMENT_KINDS = ['input', 'textarea', 'select', 'checkbox', 'radio', 'button', 'link', 'other'];
export const MODEL = {
  title: 'Checkout | Shop',
  pageUrl: 'https://shop.example/checkout',
  elements: TARGETS.map((target, i) => ({
    name: `element ${i}`,
    kind: ELEMENT_KINDS[i % ELEMENT_KINDS.length],
    inputType: i % 5 === 0 ? 'date' : undefined,
    target,
  })),
};

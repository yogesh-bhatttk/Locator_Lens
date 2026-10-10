// C9.4 — no call site may hold a giant locator, in any framework × language, for any
// target kind. The user found 4.5 KB of XPath behind getByRole('textbox', { name })
// in Selenium TypeScript; this suite renders a broad corpus (every target kind, exact
// and not, quotes and unicode, long-ish names, chains, frames, nested frames, shadow
// DOM, every action) through every exported shape — locator expressions, single
// statements, whole tests (literal and test-data), page objects — and holds every
// line, as emitted (indentation included), to a budget: at most BUDGET characters
// beyond the user-supplied text in its string literals. That includes the Locatra
// helper declarations (the compact matcher, the page-script constants, the text
// helpers), which must also appear only when a line uses them, and only once.
import { beforeAll, describe, expect, it } from 'vitest';

import { MODEL, STEPS, TARGETS, frame, kind, role } from './codegen-corpus.mjs';
import { decodeLiteral } from './codegen-helper-calls.mjs';

const BUDGET = 120;

let C;
let I;
beforeAll(async () => {
  await import('../src/codegen.js');
  await import('../src/codegen-java.js');
  await import('../src/codegen-csharp.js');
  await import('../src/codegen-wdio.js');
  C = globalThis.LLCodegen;
  I = C._internals;
});

const COMBOS = [
  ['playwright', 'typescript'],
  ['playwright', 'javascript'],
  ['playwright', 'python'],
  ['playwright', 'java'],
  ['playwright', 'csharp'],
  ['selenium', 'typescript'],
  ['selenium', 'javascript'],
  ['selenium', 'python'],
  ['selenium', 'java'],
  ['selenium', 'csharp'],
  ['cypress', 'typescript'],
  ['cypress', 'javascript'],
  ['webdriverio', 'typescript'],
  ['webdriverio', 'javascript'],
];

// ── measuring ───────────────────────────────────────────────────────────────────
/** Every string the corpus supplies (all of it recorded or typed by the user). */
function userStrings() {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk([TARGETS, STEPS, MODEL]);
  for (const u of [...out]) {
    if (/^\[/.test(u)) for (const f of JSON.parse(u)) out.add(f);
    for (const f of [I.normText(u), I.normWs(u), I.attrSel(u), I.cssIdent(u), `xpath=${u}`]) out.add(f);
  }
  out.delete('');
  return [...out].sort((a, b) => b.length - a.length);
}

const LITERAL = {
  javascript: /'(?:[^'\\\n]|\\.)*'/g,
  typescript: /'(?:[^'\\\n]|\\.)*'/g,
  python: /"(?:[^"\\\n]|\\.)*"/g,
  java: /"(?:[^"\\\n]|\\.)*"/g,
  csharp: /@"(?:[^"\n]|"")*"|"(?:[^"\\\n]|\\.)*"/g,
};

/** How much of a line is user text inside string literals (their escaped length). */
function userLength(line, lang, users) {
  let total = 0;
  for (const m of line.matchAll(LITERAL[lang])) {
    const lit = m[0];
    const decoded = decodeLiteral(lit, lang);
    if (decoded == null) continue;
    let rest = decoded;
    for (const u of users) if (rest.includes(u)) rest = rest.split(u).join('');
    // Everything of the literal but its quotes and what stays fixed is the user's.
    total += Math.max(0, lit.length - (lit.startsWith('@') ? 3 : 2) - rest.length);
  }
  return total;
}

/** Lines of `code` that are not part of a helper declaration (the call sites). */
function codeLines(code, helperLines) {
  return code.split('\n').filter((l) => l.trim() && !helperLines.has(l.trim()));
}

/**
 * The expressions a file may embed for the corpus targets, line by line, also as the
 * page objects write them (rooted at this.driver / self.driver / Driver / page, and
 * WebdriverIO's members returning the helper's promise unwrapped).
 */
function expressionLines(fw, lang) {
  const out = new Set();
  for (const t of TARGETS) {
    for (const raw of C.locatorExpr(t, fw, lang).split('\n')) {
      const l = raw.trim();
      if (!l) continue;
      out.add(l);
      for (const self of ['this.driver', 'self.driver', 'Driver']) {
        out.add(l.replaceAll('driver.', `${self}.`).replaceAll('(driver,', `(${self},`));
      }
      out.add(l.replace(/^Page\./, 'page.').replaceAll('(Page', '(page'));
      const awaited = /^\(await (locatraFind\([\s\S]*\))\)$/.exec(l);
      if (awaited) out.add(awaited[1]);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** A line with every embedded (separately budgeted) locator expression replaced by "L". */
function withoutExpressions(line, exprs) {
  let out = line;
  for (const e of exprs) if (out.includes(e) && out.trim() !== e) out = out.split(e).join('L');
  return out;
}

function fixedLength(line, lang, users) {
  return line.length - userLength(line, lang, users);
}

// The selectors a walk through shadow roots is made of (shadowHosts, shadowCss, an
// <iframe>'s shadowPath). Recorded host selectors are often whole structural paths
// (`html > body > main > … > sl-checkbox`), so they are budgeted like user text — but
// a line holds two of them only while they stay short together: a walk goes one hop
// per line (C9.4, from the real-site run).
const WALK_INLINE = 48;
function walkStrings() {
  const out = new Set();
  const walk = (t) => {
    if (!t || typeof t !== 'object') return;
    for (const k of ['shadowHosts', 'shadowPath']) if (Array.isArray(t[k])) t[k].forEach((h) => out.add(h));
    if (typeof t.shadowCss === 'string') out.add(t.shadowCss);
    walk(t.child);
    walk(t.parent);
  };
  TARGETS.forEach(walk);
  MODEL.elements.forEach((e) => walk(e.target));
  return out;
}

/** The walk selectors a line holds side by side, when together they are too long. */
function crowdedWalk(line, lang, walks) {
  const found = [];
  for (const m of line.matchAll(LITERAL[lang])) {
    const decoded = decodeLiteral(m[0], lang);
    if (decoded != null && walks.has(decoded)) found.push(decoded);
  }
  const total = found.reduce((n, s) => n + s.length, 0);
  return found.length > 1 && total > WALK_INLINE ? found : null;
}

// The definitions that make a helper "declared" in a file, per language, and what
// calls it.
const JS_HELPERS = [
  [/^\s*(?:async )?function locatraFind\(/gm, /\blocatraFind\(/],
  [/^\s*const LOCATRA_JS = /gm, /\blocatraFind\(/],
  [/^\s*function locatraGet\(/gm, /\blocatraGet\(/],
  // Cypress declares the matcher; Selenium and WebdriverIO hold it in LOCATRA_JS.
  [/^function locatraMatch\(/gm, /\b(?:locatraGet|locatraFind)\(/],
  [/^\s*function locatraFrame\(/gm, /\blocatraFrame\(/],
  [/^\s*function locatraSecret\(/gm, /\blocatraSecret\(/],
  [/^\s*(?:async )?function locatraText\(/gm, /\blocatraText\(/],
  [/^\s*const LOCATRA_TEXT = /gm, /\bLOCATRA_TEXT\b/],
  [/^\s*const LOCATRA_FRAME_JS =/gm, /\bLOCATRA_FRAME_JS\b/],
  [/^\s*const LOCATRA_SET_VALUE_JS =/gm, /\bLOCATRA_SET_VALUE_JS\b/],
];
const HELPERS = {
  javascript: JS_HELPERS,
  typescript: JS_HELPERS,
  python: [
    [/^def locatra_find\(/gm, /\blocatra_find\(/],
    [/^LOCATRA_JS = /gm, /\blocatra_find\(/],
    [/^def locatra_text\(/gm, /\blocatra_text\(/],
    [/^LOCATRA_FRAME_JS = /gm, /\bLOCATRA_FRAME_JS\b/],
    [/^LOCATRA_SET_VALUE_JS = /gm, /\bLOCATRA_SET_VALUE_JS\b/],
  ],
  // One Locatra class, holding the members the file calls.
  java: [
    [/^\s*static final class Locatra \{/gm, /\bLocatra\.(?:find|text)\(/],
    [/^\s*private static final String JS =/gm, /\bLocatra\.find\(/],
    [/^\s*static WebElement find\(SearchContext root, String kind, String value\) \{/gm, /\bLocatra\.find\(/],
    [/^\s*static String text\(WebElement el\) \{/gm, /\bLocatra\.text\(/],
    [/^\s*private static final String LOCATRA_FRAME_JS =/gm, /\bLOCATRA_FRAME_JS\b/],
    [/^\s*private static final String LOCATRA_SET_VALUE_JS =/gm, /\bLOCATRA_SET_VALUE_JS\b/],
  ],
  csharp: [
    [/^\s*private static class Locatra$/gm, /\bLocatra\.(?:Find|Text)\(/],
    [/^\s*private const string Js =/gm, /\bLocatra\.Find\(/],
    [/^\s*public static IWebElement Find\(/gm, /\bLocatra\.Find\(/],
    [/^\s*public static string Text\(IWebElement el\)/gm, /\bLocatra\.Text\(/],
    [/^\s*private const string LocatraFrameJs =/gm, /\bLocatraFrameJs\b/],
    [/^\s*private const string LocatraSetValueJs =/gm, /\bLocatraSetValueJs\b/],
  ],
};

/** Each helper is declared once per scope (the file; Cypress: also each cy.origin), exactly when called. */
function checkDeclarations(code, lang, helperLines, label) {
  const calls = codeLines(code, helperLines).join('\n');
  const scopes = 1 + (code.match(/cy\.origin\(/g) || []).length;
  for (const [def, use] of HELPERS[lang]) {
    const n = (code.match(def) || []).length;
    if (use.test(calls)) {
      expect(n, `${label}: ${def} used but not declared`).toBeGreaterThan(0);
      expect(n, `${label}: ${def} declared ${n}x`).toBeLessThanOrEqual(scopes);
    } else {
      expect(n, `${label}: ${def} declared but unused`).toBe(0);
    }
  }
}

// ── the tests ───────────────────────────────────────────────────────────────────
describe('C9.4 budget: every line within BUDGET characters beyond its user text', () => {
  const results = {};

  it.each(COMBOS)('%s / %s', async (fw, lang) => {
    const users = userStrings();
    const helperLines = new Set(
      I.allHelpers(fw, lang)
        .join('\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
    const fails = [];
    const longest = {};
    const walks = walkStrings();
    const note = (which, fixed, line, what, enforce = true) => {
      if (enforce && fixed > BUDGET) fails.push(`${what}: [${fixed}] ${line}`);
      if (fixed > (longest[which]?.fixed ?? -1)) longest[which] = { fixed, line };
    };
    // (A) Every locator expression, line by line as a statement embeds it: at most
    // BUDGET beyond its user text; so is every line of the helpers it needs.
    for (const t of TARGETS) {
      const snippet = C.locatorSnippet(t, fw, lang);
      for (const l of codeLines(snippet.expr, helperLines)) {
        note('expr', fixedLength(l.trim(), lang, users), l.trim(), `expr ${JSON.stringify(t)}`);
      }
      for (const l of snippet.helpers.split('\n'))
        note('helper', l.length, l, `helpers of ${JSON.stringify(t)}`);
    }
    // (B) Every line as emitted, indentation included — statements and the helper
    // declarations alike: at most BUDGET beyond its user text and the locator
    // expression it embeds (budgeted under A).
    const exprs = expressionLines(fw, lang);
    const check = (code, what) => {
      for (const l of code.split('\n')) {
        if (!l.trim()) continue;
        const helper = helperLines.has(l.trim());
        const line = withoutExpressions(l, exprs);
        note(helper ? 'helper' : 'stmt', fixedLength(line, lang, users), line, what);
        // Reported only: the whole line, the expression it embeds included.
        if (!helper) note('full', fixedLength(l, lang, users), l, what, false);
        const crowded = helper ? null : crowdedWalk(l, lang, walks);
        if (crowded) fails.push(`walk ${what}: ${JSON.stringify(crowded)} on one line: ${l}`);
      }
    };
    for (const step of STEPS) check(C.actionStatement(step, fw, lang), `step ${JSON.stringify(step)}`);
    const script = C.testScript(STEPS, fw, lang);
    const data = C.testScript(STEPS, fw, lang, { variables: true });
    const po = C.pageObject(MODEL, fw, lang);
    check(script, 'testScript');
    check(data, 'testScript(variables)');
    check(po, 'pageObject');
    checkDeclarations(script, lang, helperLines, `${fw}/${lang} testScript`);
    checkDeclarations(data, lang, helperLines, `${fw}/${lang} testScript(variables)`);
    checkDeclarations(po, lang, helperLines, `${fw}/${lang} pageObject`);
    results[`${fw}/${lang}`] = longest;
    if (process.env.BUDGET_DUMP) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.BUDGET_DUMP, fails.map((f) => `${fw}/${lang}\t${f}`).join('\n') + '\n');
    }
    expect(fails.slice(0, 20)).toEqual([]);
  });

  it('measured every framework / language', async () => {
    // The longest line of each kind (expression, statement, helper; "full": a statement
    // line with its expression, not budgeted) in characters beyond user text,
    // written out when BUDGET_REPORT names a file; the budget is enforced above.
    expect(Object.keys(results)).toHaveLength(COMBOS.length);
    if (process.env.BUDGET_REPORT) {
      const { writeFileSync } = await import('node:fs');
      const rows = Object.entries(results).flatMap(([k, v]) =>
        Object.entries(v).map(([which, { fixed, line }]) => `${k}\t${which} ${fixed}\t${line}`)
      );
      writeFileSync(process.env.BUDGET_REPORT, rows.join('\n') + '\n');
    }
  });
});

describe('helpers appear only when used, once per file', () => {
  it.each(COMBOS)(
    '%s / %s: a file without role / label / text / positional frames has no helper',
    (fw, lang) => {
      const plain = [
        { action: 'goto', value: 'https://e.example/' },
        { action: 'click', target: kind('id', 'go') },
        { action: 'fill', target: kind('css', 'input.q'), value: 'x' },
      ];
      const code = C.testScript(plain, fw, lang);
      expect(code, `${fw}/${lang}`).not.toMatch(/locatra|Locatra\.|LOCATRA_|LocatraFrameJs/);
      expect(C.locatorSnippet(kind('id', 'go'), fw, lang).helpers).toBe('');
    }
  );

  it.each(COMBOS)('%s / %s: one declaration however many steps call it', (fw, lang) => {
    const steps = [
      { action: 'click', target: role('button', 'A') },
      { action: 'click', target: kind('label', 'B') },
      { action: 'click', target: frame(null, kind('text', 'C')) },
      { action: 'click', target: frame(null, kind('text', 'D')) },
    ];
    const helperLines = new Set(
      I.allHelpers(fw, lang)
        .join('\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
    checkDeclarations(C.testScript(steps, fw, lang), lang, helperLines, `${fw}/${lang}`);
  });
});

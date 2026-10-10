// Shared by the codegen suites: read a Locatra helper call (C9.4) back out of the code
// every language emits — locatraFind(…) (Selenium JS/TS, WebdriverIO),
// locatra_find(…) (Python), Locatra.find(…) (Java), Locatra.Find(…) (C#),
// locatraGet(…) (Cypress) — decoding each literal the way that language's compiler
// reads it, and run the in-page matcher on what it says. So a test checks the
// escaping of every argument, not only the shape of the call.

const CALLS = {
  javascript: /\b(?:locatraFind|locatraGet)\(/,
  typescript: /\b(?:locatraFind|locatraGet)\(/,
  python: /\blocatra_find\(/,
  java: /\bLocatra\.find\(/,
  csharp: /\bLocatra\.Find\(/,
};

/** The text between a call's parentheses, from the "(" at `open`. */
function argsText(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const verbatim = c === '"' && code[i - 1] === '@';
      for (i++; i < code.length; i++) {
        if (verbatim && code[i] === '"' && code[i + 1] === '"') i++;
        else if (!verbatim && code[i] === '\\') i++;
        else if (code[i] === c) break;
      }
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced call in ${code}`);
}

/** Top-level comma-separated pieces of an argument list. */
function split(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const verbatim = c === '"' && text[i - 1] === '@';
      for (i++; i < text.length; i++) {
        if (verbatim && text[i] === '"' && text[i + 1] === '"') i++;
        else if (!verbatim && text[i] === '\\') i++;
        else if (text[i] === c) break;
      }
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s !== '');
}

const SIMPLE = {
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
  v: '\v',
  a: '\x07',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

/** A string literal's value, decoded as `lang` reads it (null when it is no literal). */
export function decodeLiteral(lit, lang) {
  if (lang === 'csharp' && lit.startsWith('@"')) return lit.slice(2, -1).replace(/""/g, '"');
  const q = lit[0];
  if ((q !== '"' && q !== "'") || lit[lit.length - 1] !== q) return null;
  const body = lit.slice(1, -1);
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (m, e) => {
    if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) {
      if (lang === 'java') return String.fromCharCode(parseInt(e, 8));
      // C# and JavaScript: only \0 (never followed by a digit in generated code).
      return '\0' + e.slice(1);
    }
    return Object.prototype.hasOwnProperty.call(SIMPLE, e) ? SIMPLE[e] : e;
  });
}

/**
 * The first helper call in `code`: { root, kind, value, name, exact, level, nth,
 * within } (root: the receiver expression, null for WebdriverIO and Cypress), or
 * null when the code calls no helper.
 */
export function helperCallOf(code, lang) {
  const span = helperCallSpan(code, lang);
  return span && span.call;
}

/** Where the first helper call in `code` starts and ends ([start, end)), and what it says. */
export function helperCallSpan(code, lang) {
  const m = CALLS[lang].exec(code);
  if (!m) return null;
  const args = argsText(code, m.index + m[0].length - 1);
  return { start: m.index, end: m.index + m[0].length + args.length + 1, call: decodeCall(args, lang) };
}

function decodeCall(args, lang) {
  const parts = split(args);
  const call = {
    root: null,
    kind: null,
    value: null,
    name: null,
    exact: false,
    level: 0,
    nth: -1,
    within: null,
  };
  let rest = parts;
  // Selenium roots the call at the driver or an element; WebdriverIO and Cypress do not.
  if (lang === 'python' || lang === 'java' || lang === 'csharp' || decodeLiteral(parts[0], lang) == null) {
    call.root = parts[0];
    rest = parts.slice(1);
  }
  const positional = [];
  for (const p of rest) {
    const kw = /^(exact|level|nth|within)\s*[:=]\s*([\s\S]+)$/.exec(p);
    if (p.startsWith('{')) {
      for (const entry of split(p.slice(1, -1))) {
        const [, key, val] = /^(\w+):\s*([\s\S]+)$/.exec(entry);
        call[key] = key === 'within' ? val : key === 'exact' ? val === 'true' : Number(val);
      }
    } else if (kw) {
      const val = kw[2];
      call[kw[1]] = kw[1] === 'within' ? val : kw[1] === 'exact' ? /^(true|True)$/.test(val) : Number(val);
    } else {
      positional.push(p);
    }
  }
  const names = ['kind', 'value', 'name', 'exact', 'level', 'nth'];
  positional.forEach((p, i) => {
    const key = names[i];
    if (p === 'null' || p === 'None') call[key] = null;
    else if (/^(true|false|True|False)$/.test(p)) call[key] = /^t/i.test(p);
    else if (/^-?\d+$/.test(p)) call[key] = Number(p);
    else call[key] = decodeLiteral(p, lang);
  });
  return call;
}

/**
 * What the helper finds in `doc` for a decoded call: the matcher run the way every
 * helper runs it, then the helper's own rule (exactly one, or the nth).
 */
export function runHelper(I, doc, call, scope = null) {
  // jsdom has no pseudo-element styles (it logs "not implemented"); the engine skips them there.
  const view = doc.defaultView;
  const real = view.getComputedStyle;
  view.getComputedStyle = (el, pseudo) => (pseudo ? null : real.call(view, el));
  try {
    const run = new Function(I.MATCH_JS);
    const found = run(call.kind, call.value, call.name, !!call.exact, call.level || 0, scope || doc);
    return call.nth >= 0 ? found.slice(call.nth, call.nth + 1) : found;
  } finally {
    view.getComputedStyle = real;
  }
}

// ── fake runtimes: run the generated JavaScript helpers against a jsdom document ──
// Just enough of selenium-webdriver, Cypress and WebdriverIO for an emitted locator
// expression and its helper declaration to run as written, in Node: the page script
// runs on `doc` (as executeScript runs it in the browser), elements come back
// wrapped. So the helper's own logic (waiting, exactly one, nth, a parent root) is
// exercised, not only the matcher.

/** Run a page script the way a WebDriver executeScript() does: `document` is the page's. */
function pageScript(doc, script, args) {
  return new Function('document', `return (function () {\n${script}\n}).apply(null, arguments[1]);`)(
    doc,
    args
  );
}

function byFinder(by, root, doc) {
  if (by.css) return root.querySelector(by.css);
  if (by.id) return doc.getElementById(by.id);
  if (by.name) return root.querySelector(`[name="${by.name}"]`);
  const r = doc.evaluate(by.xpath, root, null, 9, null);
  return r.singleNodeValue;
}

/** selenium-webdriver's driver, By and WebElementPromise over `doc`. */
export function seleniumJs(doc, { implicit = 0 } = {}) {
  const calls = { scripts: 0, sleeps: 0 };
  class WebElement {
    constructor(driver, el) {
      this.driver = driver;
      this.el = el;
    }
    getDriver() {
      return this.driver;
    }
    findElement(by) {
      return new WebElementPromise(
        this.driver,
        Promise.resolve(this).then((self) => {
          const el = byFinder(by, self.el, doc);
          if (!el) throw new Error(`no such element: ${JSON.stringify(by)}`);
          return new WebElement(this.driver, el);
        })
      );
    }
  }
  class WebElementPromise extends WebElement {
    constructor(driver, promise) {
      super(driver, null);
      this.promise = promise;
    }
    then(res, rej) {
      return this.promise.then(res, rej);
    }
    findElement(by) {
      return new WebElementPromise(
        this.driver,
        this.promise.then((el) => el.findElement(by))
      );
    }
  }
  const driver = {
    calls,
    findElement(by) {
      const el = byFinder(by, doc, doc);
      return new WebElementPromise(
        driver,
        el ? Promise.resolve(new WebElement(driver, el)) : Promise.reject(new Error('no such element'))
      );
    },
    async executeScript(script, ...args) {
      calls.scripts++;
      const out = pageScript(
        doc,
        script,
        args.map((a) => (a instanceof WebElement ? a.el : a))
      );
      return Array.isArray(out) ? out.map((el) => new WebElement(driver, el)) : out;
    },
    manage: () => ({ getTimeouts: async () => ({ implicit }) }),
    async sleep(ms) {
      calls.sleeps++;
      await new Promise((r) => globalThis.setTimeout(r, Math.min(ms, 20)));
    },
  };
  const By = {
    css: (css) => ({ css }),
    id: (id) => ({ id }),
    name: (name) => ({ name }),
    xpath: (xpath) => ({ xpath }),
  };
  return { driver, By, WebElementPromise };
}

/** Evaluate a Selenium JS/TS locator expression with its helpers; resolves to the DOM element. */
export async function runSeleniumJs(C, doc, expr, opts) {
  const { driver, By, WebElementPromise } = seleniumJs(doc, opts);
  const helpers = C._internals.selHelperSource('javascript');
  const run = new Function('driver', 'By', 'WebElementPromise', `${helpers}\nreturn ${expr};`);
  const el = await run(driver, By, WebElementPromise);
  return el.el;
}

/** A jQuery-like subject: indexable, plus `els`. */
function jq(els) {
  const out = { els, length: els.length };
  els.forEach((e, i) => (out[i] = e));
  return out;
}

/**
 * Evaluate a Cypress locator expression with its helpers on `doc`, with a cy that
 * runs each command once (no retrying): resolves to the subject's elements. `expect`
 * is chai's (vitest's), as in a spec.
 */
export function runCypress(C, doc, expr, expect) {
  const chain = (subject) => ({
    subject,
    should(cb) {
      cb(subject);
      return chain(subject);
    },
    then(fn) {
      const r = fn(subject);
      return r && r.subject !== undefined ? r : chain(r === undefined ? subject : r);
    },
    find(sel) {
      return chain(jq(subject.els.flatMap((e) => [...e.querySelectorAll(sel)])));
    },
  });
  const cy = { document: () => chain(doc), get: (sel) => chain(jq([...doc.querySelectorAll(sel)])) };
  const Cypress = { $: (el) => jq(el ? [el] : []) };
  const helpers = C._internals.cyGetSource('javascript');
  const res = new Function('cy', 'Cypress', 'expect', `${helpers}\nreturn ${expr};`)(cy, Cypress, expect);
  return res.subject.els;
}

/** Evaluate a WebdriverIO locator expression with its helpers on `doc`: resolves to the element. */
export async function runWdio(C, doc, expr, { tries = 3 } = {}) {
  class El {
    constructor(el) {
      this.el = el;
    }
    $(sel) {
      return wrapPromise(Promise.resolve(this).then((self) => new El(select(sel, self.el))));
    }
  }
  const select = (sel, root) => {
    if (/^(\/|\(|\.\.?\/)/.test(sel) || sel.startsWith('xpath:')) {
      return doc.evaluate(sel.replace(/^xpath:/, ''), root, null, 9, null).singleNodeValue;
    }
    return root.querySelector(sel.replace(/^css selector:/, ''));
  };
  const wrapPromise = (p) => Object.assign(p, { $: (sel) => wrapPromise(p.then((e) => e.$(sel))) });
  const $ = (x) => wrapPromise(Promise.resolve(typeof x === 'string' ? new El(select(x, doc)) : new El(x)));
  const browser = {
    async execute(script, ...args) {
      return pageScript(
        doc,
        script,
        await Promise.all(args.map(async (a) => ((await a) instanceof El ? (await a).el : a)))
      );
    },
    async waitUntil(fn, opts) {
      for (let i = 0; i < tries; i++) if (await fn()) return true;
      throw new Error(opts.timeoutMsg);
    },
  };
  const helpers = C._internals.uses(expr, 'locatraFind') ? wdioHelper(C) : '';
  const run = new Function('browser', '$', `${helpers}\nreturn (async () => ${expr})();`);
  return (await run(browser, $)).el;
}

function wdioHelper(C) {
  return C.locatorSnippet({ kind: 'text', value: 'x' }, 'webdriverio', 'javascript').helpers;
}

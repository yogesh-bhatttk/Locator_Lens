// Selenium for Python, run for real (python3): the generated files compile
// (py_compile) for the whole C9.4 corpus, and the locatra_find() helper does what its
// JavaScript twin does — exactly one match, or the nth; polls until the driver's
// implicit wait runs out; roots a chained lookup at the parent element — against a
// fake driver whose execute_script() answers what the page would. Skipped where
// python3 is missing. With the e2e Python packages installed
// (npm run test:exports:setup-python) the selenium imports are the real ones.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as CORPUS from './codegen-corpus.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PYLIB = join(ROOT, 'node_modules/.cache/locatra-e2e/pylib');
const HAS_SELENIUM = existsSync(join(PYLIB, 'selenium/__init__.py'));

function hasPython() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
const PYTHON = hasPython();

let C;
let dir;
beforeAll(async () => {
  await import('../src/codegen.js');
  C = globalThis.LLCodegen;
  dir = mkdtempSync(join(tmpdir(), 'locatra-py-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function python(script, args = []) {
  const file = join(dir, `run-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, script);
  const env = { ...process.env, ...(HAS_SELENIUM ? { PYTHONPATH: PYLIB } : {}) };
  return execFileSync('python3', [HAS_SELENIUM ? '-S' : '-I', file, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    env,
  });
}

describe.skipIf(!PYTHON)('Selenium for Python', () => {
  it('compiles every generated file of the corpus', () => {
    const files = {
      'selenium_script.py': C.testScript(CORPUS.STEPS, 'selenium', 'python'),
      'selenium_data.py': C.testScript(CORPUS.STEPS, 'selenium', 'python', { variables: true }),
      'selenium_page.py': C.pageObject(CORPUS.MODEL, 'selenium', 'python'),
      'playwright_script.py': C.testScript(CORPUS.STEPS, 'playwright', 'python'),
      'playwright_page.py': C.pageObject(CORPUS.MODEL, 'playwright', 'python'),
    };
    for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code);
    const out = python(
      'import py_compile, sys\nfor f in sys.argv[1:]:\n    py_compile.compile(f, doraise=True)\nprint("ok")\n',
      Object.keys(files).map((f) => join(dir, f))
    );
    expect(out.trim()).toBe('ok');
  });

  it('locatra_find: exactly one, the nth, polling, a parent root', () => {
    const helper = C._internals.selHelperSource('python');
    const imports = HAS_SELENIUM
      ? 'from selenium.common.exceptions import NoSuchElementException, WebDriverException\n'
      : 'class NoSuchElementException(Exception):\n    pass\n\n\nclass WebDriverException(Exception):\n    pass\n';
    const harness = `import json
import time
${imports}

${helper}


class Timeouts:
    def __init__(self, wait):
        self.implicit_wait = wait


class Driver:
    def __init__(self, answers, wait=0):
        self.answers = list(answers)
        self.calls = []
        self.timeouts = Timeouts(wait)

    def execute_script(self, js, *args):
        self.calls.append([js == LOCATRA_JS] + [a if not isinstance(a, El) else "<" + a.name + ">" for a in args])
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


class El:
    def __init__(self, name, parent=None):
        self.name = name
        self.parent = parent


def name_of(x):
    return x.name


out = {}
a, b = El("a"), El("b")
d = Driver([[a]])
out["one"] = [name_of(locatra_find(d, "role", "textbox", "Username or Email")), d.calls]
try:
    locatra_find(Driver([[a, b]]), "role", "button", "Save", exact=True)
except WebDriverException as e:
    out["two"] = str(e)
out["nth"] = name_of(locatra_find(Driver([[a, b]]), "role", "row", nth=1))
d = Driver([[], [], [b]], wait=5)
out["poll"] = [name_of(locatra_find(d, "text", "Later")), len(d.calls)]
t0 = time.monotonic()
try:
    locatra_find(Driver([[]], wait=0.2), "label", "Nope")
except NoSuchElementException as e:
    out["none"] = [str(e), round(time.monotonic() - t0, 1) >= 0.2]
d = Driver([[a]])
row = El("row", parent=d)
out["root"] = [name_of(locatra_find(row, "role", "button", "Delete", level=2)), d.calls]
print(json.dumps(out))
`;
    const out = JSON.parse(python(harness));
    expect(out.one).toEqual(['a', [[true, 'role', 'textbox', 'Username or Email', false, 0, null]]]);
    expect(out.two).toContain(
      "Locatra: 2 elements match role 'button' named 'Save' (exact); expected exactly one"
    );
    expect(out.nth).toBe('b');
    expect(out.poll).toEqual(['b', 3]);
    expect(out.none[0]).toContain("Locatra: no element matches label 'Nope'");
    expect(out.none[1]).toBe(true);
    expect(out.root).toEqual(['a', [[true, 'role', 'button', 'Delete', false, 2, '<row>']]]);
  });
});

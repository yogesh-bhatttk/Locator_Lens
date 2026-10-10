// @vitest-environment jsdom
//
// The CSS fallback never leans on a state class (the page sets it as the user
// interacts: a selector built after TodoMVC's click said li.completed and missed on
// replay), and it counts a shadow root's top-level siblings for :nth-of-type.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let E;
beforeAll(() => {
  vm.runInThisContext(readFileSync(join(ROOT, 'src/content-locator-engine.js'), 'utf8'), {
    filename: 'src/content-locator-engine.js',
  });
  E = globalThis.__LocatorLensEngine;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('isStateClass', () => {
  it.each([
    'completed',
    'active',
    'selected',
    'checked',
    'open',
    'expanded',
    'disabled',
    'focus',
    'focused',
    'hover',
    'current',
    'is-active',
    'is-open',
    'has-error',
    'ng-dirty',
    'ng-star-inserted',
    'tab--active',
    'menu__item--selected',
    'nav-item-active',
  ])('%s is a state class', (c) => {
    expect(E.isStateClass(c)).toBe(true);
  });

  it.each([
    'toggle',
    'view',
    'todo-list',
    'btn-primary',
    'card__title',
    'autocomplete',
    'actions',
    'opener',
    'checkbox',
  ])('%s is not', (c) => {
    expect(E.isStateClass(c)).toBe(false);
  });
});

describe('buildCSSSelector and state classes', () => {
  it('a TodoMVC row toggled by the click is located without `completed`', () => {
    document.body.innerHTML =
      '<ul class="todo-list">' +
      '<li><div class="view"><input class="toggle" type="checkbox"></div></li>'.repeat(3) +
      '</ul>';
    const li = document.querySelectorAll('li')[1];
    li.className = 'completed';
    const toggle = li.querySelector('input');
    const sel = E.buildCSSSelector(toggle);
    expect(sel).not.toContain('completed');
    expect(Array.from(document.querySelectorAll(sel))).toEqual([toggle]);
    li.className = ''; // the DOM a replay starts from
    expect(Array.from(document.querySelectorAll(sel))).toEqual([toggle]);
  });

  it('BEM and is-* modifiers are skipped, the stable class kept', () => {
    document.body.innerHTML = '<nav><a class="tab tab--active is-current">A</a><a class="tab">B</a></nav>';
    const sel = E.buildCSSSelector(document.querySelector('a'));
    expect(sel).toBe('a.tab:nth-of-type(1)');
  });

  it('a shadow root’s top-level siblings get :nth-of-type too', () => {
    document.body.innerHTML = '<x-list id="l"></x-list>';
    const root = document.getElementById('l').attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="item"></div><div class="item is-selected"></div><div class="item"></div>';
    const el = root.querySelectorAll('div')[1];
    const sel = E.buildCSSSelector(el);
    expect(sel).toBe('div.item:nth-of-type(2)');
    expect(E.countTargetMatches({ kind: 'css', value: sel })).toBe(1);
  });
});

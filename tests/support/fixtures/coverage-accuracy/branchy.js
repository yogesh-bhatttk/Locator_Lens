// Fixture for tests/support/coverage-accuracy.test.mjs: a classic script shaped like
// the extension's (IIFE publishing onto the global object, `var`, nested functions)
// with branches whose outcome the workload controls exactly. Lines tagged HIT must
// be reported covered and lines tagged MISS uncovered, whichever way it is loaded.
(function (global) {
  'use strict';

  var calls = 0;

  function classify(n) {
    calls++;
    if (n < 0) {
      return 'negative'; // HIT
    }
    if (n === 0) {
      return 'zero'; // MISS
    }
    var label = n > 100 ? 'big' : 'small';
    if (label === 'big') {
      label = label.toUpperCase(); // MISS
    }
    return label; // HIT
  }

  function pick(kind) {
    switch (kind) {
      case 'a':
        return 1; // HIT
      case 'b':
        return 2; // MISS
      default:
        return kind ? 3 : 4; // HIT
    }
  }

  function neverCalled() {
    return 'never'; // MISS
  }

  function guard(obj) {
    var name = (obj && obj.name) || 'anon';
    if (!obj) return name; // HIT
    return name.length > 3 ? name : name + '!'; // HIT
  }

  global.LLBranchy = {
    classify: classify,
    pick: pick,
    guard: guard,
    neverCalled: typeof neverCalled === 'function' ? null : neverCalled,
    count: function () {
      return calls;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);

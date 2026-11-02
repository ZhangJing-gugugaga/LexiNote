#!/usr/bin/env node
'use strict';
// HARNESS-ONLY ladder stubs.
//
// Every entry below closes a hole that the SHIPPED rawfile shim really has. The
// stubs live here, inside the offline harness, and are injected into the live
// namespace copy (window.LexiObsidian.namespace) before the plugin is dispatched.
// Nothing in entry/src/main/resources/rawfile is touched, so on a real device each
// of these symbols is still MISSING — the ladder measures distance, not delivery.
const LEVELS = [
  {
    id: 1,
    missingSymbol: 'EditorSuggest',
    crashPoint: 'tools/plugins-fixtures/local/obsidian-tasks/main.js:602',
    observedError: 'Class extends value undefined is not a constructor or null',
    harnessStub: 'class EditorSuggest { constructor(app) } + close/open/setInstructions 空实现',
    snippet: [
      'class EditorSuggest {',
      '  constructor(app) { this.app = app; this.context = null; this.suggestions = []; }',
      '  setInstructions() {} close() {} open() {} onTrigger() { return null; }',
      '  getSuggestions() { return []; } renderSuggestion() {} selectSuggestion() {}',
      '}'
    ].join('\n'),
    apply(ns) {
      ns.EditorSuggest = class EditorSuggest {
        constructor(app) { this.app = app; this.context = null; this.suggestions = []; }
        setInstructions() {} close() {} open() {} onTrigger() { return null; }
        getSuggestions() { return []; } renderSuggestion() {} selectSuggestion() {}
      };
      return 'EditorSuggest';
    }
  },
  {
    id: 2,
    missingSymbol: 'getLanguage',
    crashPoint: 'tools/plugins-fixtures/local/obsidian-tasks/main.js:220',
    observedError: '(0 , QS.getLanguage) is not a function',
    harnessStub: "getLanguage() => 'en'",
    snippet: "ns.getLanguage = function () { return 'en'; };",
    apply(ns) {
      ns.getLanguage = function () { return 'en'; };
      return 'getLanguage';
    }
  },
  {
    id: 3,
    missingSymbol: 'app.scope (App keymap Scope)',
    crashPoint: 'tools/plugins-fixtures/local/obsidian-tasks/main.js:602',
    observedError: "Cannot read properties of null (reading 'register')",
    harnessStub: "app.scope = new Scope(); Scope.prototype.register/unregister 空实现",
    snippet: [
      'const base = ns.EditorSuggest;',
      'ns.Scope.prototype.register = function () { return this; };',
      'ns.Scope.prototype.unregister = function () {};',
      'ns.EditorSuggest = class extends base {',
      '  constructor(app) { if (app && !app.scope) { app.scope = new ns.Scope(); } super(app); }',
      '};'
    ].join('\n'),
    apply(ns) {
      // Level 3 extends the class level 1 installs; a red-light run that removes level 1
      // would otherwise crash the ladder itself instead of falling back to level 1's error.
      if (typeof ns.EditorSuggest !== 'function') return 'app.scope (skipped: level 1 not applied)';
      const base = ns.EditorSuggest;
      ns.Scope.prototype.register = function () { return this; };
      ns.Scope.prototype.unregister = function () {};
      ns.EditorSuggest = class extends base {
        constructor(app) { if (app && !app.scope) { app.scope = new ns.Scope(); } super(app); }
      };
      return 'app.scope';
    }
  }
];

module.exports = { LEVELS };

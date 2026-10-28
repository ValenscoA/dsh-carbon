import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import ReactDOMServer from 'react-dom/server';
import { en, zh } from '../src/client/locales.js';

const { createElement: h } = React;
const { renderToStaticMarkup } = ReactDOMServer;

/* Load the built bundle exactly as the shell does: a script that registers a
 * factory on `window.__ModuleLoader__`. This tests the artifact that ships, not
 * a source rewrite. */
let registration;
globalThis.window = { __ModuleLoader__: { load(value) { registration = value; } } };
await import(`${pathToFileURL(new URL('../lib/client.js', import.meta.url).pathname).href}?test=${Date.now()}`);

function requireStub(id) {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  throw new Error(`unexpected require("${id}")`);
}

const bundle = registration.factory(requireStub);

function translate(locale = 'en') {
  const dictionary = locale === 'zh' ? zh : en;
  return (key, params) => {
    const template = dictionary[key] ?? key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

function makeCtx(locale = 'en') {
  const effects = [];
  const registrations = [];
  const injected = [];
  const ctx = {
    effect(callback) {
      effects.push(callback());
    },
    locale: {
      register() {
        return () => {};
      },
      bind() {
        return translate(locale);
      },
      subscribe() {
        return () => {};
      },
      getSnapshot() {
        return { active: locale };
      },
    },
    slots: {
      inject(name, register) {
        injected.push(name);
        register();
      },
      register(meta, component) {
        registrations.push({ meta, component });
        return () => {};
      },
    },
  };
  return { ctx, effects, registrations, injected };
}

function fakeDocument() {
  const nodes = [];
  const document = {
    createElement(tag) {
      return {
        tag,
        attributes: {},
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = value; },
        remove() {
          const at = nodes.indexOf(this);
          if (at !== -1) nodes.splice(at, 1);
        },
      };
    },
    head: {
      appendChild(node) {
        nodes.push(node);
      },
    },
  };
  return { document, nodes };
}

test('the bundle registers a main panel and its sidebar row', () => {
  assert.equal(registration.id, 'dsh-carbon');
  assert.equal(bundle.name, 'dsh-carbon');
  assert.deepEqual(bundle.inject, ['slots', 'locale']);
  assert.equal(typeof bundle.apply, 'function');

  const original = globalThis.document;
  const { document, nodes } = fakeDocument();
  globalThis.document = document;
  try {
    const { ctx, registrations, injected } = makeCtx();
    bundle.apply(ctx);

    assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist']);

    const main = registrations.find((entry) => entry.meta.name === 'main');
    const row = registrations.find((entry) => entry.meta.name === 'sidebar.panellist');
    assert.ok(main, 'main slot registered');
    assert.ok(row, 'sidebar row registered');
    assert.equal(main.meta.key, 'dsh-carbon');
    assert.equal(row.meta.id, 'dsh-carbon');
    assert.equal(typeof row.meta.label, 'function');
    assert.equal(row.meta.label(), 'Carbon');
    assert.equal(typeof row.component, 'function');

    assert.equal(nodes.length, 1, 'one stylesheet injected');
    assert.match(nodes[0].textContent, /\.dshc-page/);
  } finally {
    globalThis.document = original;
  }
});

test('the panel renders its header and loading state without a host', () => {
  const { ctx, registrations } = makeCtx();
  bundle.apply(ctx);
  const main = registrations.find((entry) => entry.meta.name === 'main');
  assert.ok(main, 'main registration');

  const html = renderToStaticMarkup(h(main.component, {
    t: translate('en'),
    localeService: ctx.locale,
  }));

  assert.match(html, /class="dshc-page"/);
  assert.match(html, />Carbon</);
  assert.match(html, /Estimated CO/);
  assert.match(html, /dshc-skeleton/);
  assert.match(html, /Overview/);
  assert.match(html, /Method/);
});

test('the panel keeps its Chinese copy when the locale changes', () => {
  const { ctx, registrations } = makeCtx('zh');
  bundle.apply(ctx);
  const main = registrations.find((entry) => entry.meta.name === 'main');
  const html = renderToStaticMarkup(h(main.component, {
    t: translate('zh'),
    localeService: ctx.locale,
  }));
  assert.match(html, /\u78b3\u8db3\u8ff9/);
  assert.match(html, /\u6982\u89c8/);
});

test('session rows show grams, tokens and their confidence tier', () => {
  const { SessionList } = bundle.__test;
  const html = renderToStaticMarkup(h(SessionList, {
    t: translate('en'),
    locale: 'en',
    expanded: false,
    onToggle() {},
    sessions: [
      {
        id: 'session-12345678-abcd',
        cwd: '/Users/me/work',
        firstUsageAt: Date.UTC(2026, 9, 28, 5, 14),
        lastUsageAt: Date.UTC(2026, 9, 28, 5, 20),
        grams: 1234.5,
        low: 617,
        high: 3703,
        tier: 'derived',
        tokens: 1_200_000,
        calls: 12,
        models: [{ model: 'deepseek-v4.1-flash' }],
      },
    ],
  }));

  assert.match(html, /1\.23\s*kg/);
  assert.match(html, /1\.2M/);
  assert.match(html, /Derived/);
  assert.match(html, /12345678/);
});

test('model rows show the share and the alias match', () => {
  const { ModelList } = bundle.__test;
  const html = renderToStaticMarkup(h(ModelList, {
    t: translate('en'),
    locale: 'en',
    models: [
      {
        factorId: 'deepseek-v4.1-flash',
        tier: 'derived',
        grams: 900,
        share: 0.9,
        tokens: 10_000,
        calls: 20,
        models: ['deepseek-v4.1-flash', 'deepseek-flash'],
        factor: { input: 11, output: 2028, lowMultiplier: 0.5, highMultiplier: 3 },
      },
      {
        factorId: 'deepseek-v3',
        tier: 'measured',
        grams: 100,
        share: 0.1,
        tokens: 1_000,
        calls: 1,
        models: ['deepseek-v3'],
        factor: { input: 28, output: 5289, lowMultiplier: 0.14, highMultiplier: 2.51 },
      },
    ],
  }));

  assert.match(html, /90% of the total/);
  assert.match(html, /matches deepseek-flash/);
  assert.match(html, /11 \u2192 2,028 g \/ Mtok/);
  assert.match(html, /band \u00d70\.5 \u2013 \u00d73/);
  assert.match(html, /Measured/);
});

test('the method view renders every factor, its band and its source link', () => {
  const { MethodView } = bundle.__test;
  const html = renderToStaticMarkup(h(MethodView, {
    t: translate('en'),
    locale: 'en',
    summary: {
      infrastructure: { key: 'deepseek_own_china', cif: 0.6, pue: 1.27, scale: 1 },
    },
    method: {
      status: 'ready',
      error: null,
      retry() {},
      data: {
        methodologyVersion: 1,
        cacheReadFactor: { value: 0.08 },
        infrastructure: {},
        models: [
          {
            id: 'deepseek-v4.1-flash',
            tier: 'derived',
            input: 11,
            output: 2028,
            band: { low_multiplier: 0.5, high_multiplier: 3 },
            source: 'Derived from https://arxiv.org/abs/2505.09598 Table 4.',
            caveat: 'No published measurement exists for this model.',
            fit: { mape: 0.02 },
          },
        ],
        crossChecks: {
          accessed: '2026-10-28',
          items: [
            {
              id: 'kyc-v4-flash',
              source: 'Know Your Compute',
              url: 'https://www.knowyourcompute.com/models/deepseek-v4-flash',
              model: 'DeepSeek-V4-Flash',
              tier: 'estimated',
              whPerQuery: 1,
              gramsPerQuery: 0.53,
              verdict: 'order-of-magnitude',
            },
            {
              id: 'kyc-v3',
              source: 'Know Your Compute',
              url: 'https://www.knowyourcompute.com/models/deepseek-v3',
              model: 'DeepSeek-V3',
              tier: 'peer-reviewed (site label)',
              whPerQuery: 2,
              gramsPerQuery: 1.1,
              verdict: 'not-used',
            },
          ],
        },
        fallback: {
          id: 'unknown',
          tier: 'unknown',
          input: 11,
          output: 2028,
          band: { low_multiplier: 0.5, high_multiplier: 6 },
          source: 'Fallback row.',
          caveat: 'An unmatched model means the report is a guess.',
        },
      },
    },
  }));

  assert.match(html, /deepseek-v4\.1-flash/);
  assert.match(html, /DeepSeek fleet/);
  assert.match(html, /0\.6 kgCO/);
  assert.match(html, /\u00d70\.5/);
  assert.match(html, /href="https:\/\/arxiv\.org\/abs\/2505\.09598"/);
  assert.match(html, /No published measurement exists/);
  assert.match(html, /Methodology v1/);
  assert.match(html, /Cross-checks/);
  assert.match(html, /Know Your Compute/);
  assert.match(html, /1 Wh/);
  assert.match(html, /0\.53 g CO/);
  assert.match(html, /Order-of-magnitude agreement/);
  assert.match(html, /Not used:/);
  assert.match(html, /href="https:\/\/www\.knowyourcompute\.com\/models\/deepseek-v4-flash"/);
});

test('grams, percentages and costs use the same thresholds as the CLI', () => {
  const { formatGrams, percent, usd } = bundle.__test;
  assert.deepEqual(formatGrams(0), { value: '0', unit: 'g' });
  assert.deepEqual(formatGrams(238.7), { value: '239', unit: 'g' });
  assert.deepEqual(formatGrams(1234), { value: '1.23', unit: 'kg' });
  assert.deepEqual(formatGrams(0.42), { value: '0.42', unit: 'g' });
  assert.equal(percent(96.2), '96');
  assert.equal(percent(0.4, 1), '0.4');
  assert.equal(usd(1.6339), '$1.63');
  assert.equal(usd(0.2484), '$0.2484');
});

test('the heat tint runs green to yellow to red and clamps at both ends', () => {
  const { heatTone } = bundle.__test;

  assert.equal(heatTone(0).band, 'low');
  assert.equal(heatTone(250).load, 0);
  assert.equal(heatTone(1370).band, 'moderate');
  assert.equal(heatTone(5000).load, 1);
  assert.equal(heatTone(5000).band, 'high');
  assert.equal(heatTone(1_000_000).load, 1);

  const hues = [300, 600, 1200, 2500, 6000].map((grams) => {
    const match = /^hsl\(([\d.]+)/.exec(heatTone(grams).color);
    assert.ok(match, `colour parses for ${grams}: ${heatTone(grams).color}`);
    return Number(match[1]);
  });
  for (let i = 1; i < hues.length; i += 1) {
    assert.ok(hues[i] <= hues[i - 1], `hue falls from ${hues[i - 1]} to ${hues[i]}`);
  }
  assert.match(heatTone(250).color, /^hsl\(152\.0 /);
  assert.match(heatTone(5000).color, /^hsl\(2\.0 /);
});

test('the hero wears the heat tone and names its band', () => {
  const { Hero } = bundle.__test;
  const data = {
    totals: {
      grams: 1400,
      low: 700,
      high: 4200,
      tokens: 1000,
      input: 100,
      output: 200,
      cacheRead: 700,
      cacheWrite: 0,
      calls: 5,
      cost: 1,
      unpriced: false,
      measured: 0,
      unmeasured: 1,
      sessions: 1,
    },
    equivalences: [
      { id: 'car', divisor: 170, decimals: 1 },
      { id: 'kettle', divisor: 24, decimals: 1 },
      { id: 'phone', divisor: 0.2, decimals: 0 },
    ],
  };

  const html = renderToStaticMarkup(h(Hero, { t: translate('en'), locale: 'en', data }));
  assert.match(html, /style="--dshc-heat:hsl\([\d.]+ /);
  assert.match(html, />Moderate</);
  assert.match(html, /green up to 250\s*g, red from 5\.00\s*kg/);
});

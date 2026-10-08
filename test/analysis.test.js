'use strict';
process.env.DATABASE_URL = 'pglite:memory';
process.env.DEEPSEEK_API_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../src/core/db');
const { analyzeProspect, latestAnalysis, providerErrorMessage } = require('../src/research/ai-analysis');
const { exportProspect, eraseProspect } = require('../src/compliance/export');

test.after(() => db.close());

test('DeepSeek HTTP 402 explains that API balance is required', () => {
  assert.match(providerErrorMessage(402), /insufficient balance/i);
  assert.match(providerErrorMessage(401), /API key/i);
});

test('DeepSeek action plans use audit evidence, persist, export, and erase', async () => {
  const prospect = await db.get(`INSERT INTO prospects (name, sector, district, website_url, website_status)
    VALUES ('Fixit Hardware', 'retail', 'Gasabo', 'http://fixit.rw', 'live') RETURNING id`);
  await db.run(`INSERT INTO audits (prospect_id, http_status, final_url, signals, score)
    VALUES (?, 200, 'http://fixit.rw', ?, 30)`, prospect.id, JSON.stringify({ no_https: true, not_mobile: true }));

  const report = {
    executive_summary: 'Secure and improve the existing website, starting with the visitor risks found in the audit.',
    steps: [
      { title: 'Enable HTTPS', reason: 'The audit found no HTTPS.', actions: ['Configure a valid TLS certificate.', 'Redirect HTTP traffic to HTTPS.'], success_looks_like: 'The site loads securely at its HTTPS address.' },
      { title: 'Improve mobile layout', reason: 'The audit found the site difficult to use on phones.', actions: ['Test the main pages on a phone.', 'Adjust the layout for narrow screens.'], success_looks_like: 'Pages fit and work at a mobile viewport.' }
    ],
    quick_wins: ['Add a visible call button.'],
    questions: ['Who currently updates the website?']
  };
  const originalFetch = global.fetch;
  let sent;
  global.fetch = async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(report) } }] }) };
  };

  try {
    const saved = await analyzeProspect(prospect.id);
    assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(sent.options.headers.Authorization, 'Bearer test-key');
    assert.equal(sent.body.model, 'deepseek-chat');
    assert.match(sent.body.messages[1].content, /no_https/);
    assert.equal(saved.report.steps.length, 2);

    const loaded = await latestAnalysis(prospect.id);
    assert.equal(loaded.id, saved.id);
    assert.deepEqual(loaded.report, report);
    assert.ok(loaded.findings.some((finding) => finding.key === 'no_https'));
    const exported = (await exportProspect(prospect.id)).ai_analyses[0];
    assert.deepEqual(exported.report, report);
    assert.ok(exported.findings.some((finding) => finding.key === 'no_https'));

    await eraseProspect(prospect.id);
    assert.equal(await latestAnalysis(prospect.id), null);
  } finally {
    global.fetch = originalFetch;
  }
});
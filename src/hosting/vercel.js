'use strict';
const { VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT } = require('../core/config');

const API = 'https://api.vercel.com';

function enabled() {
  return Boolean(VERCEL_TOKEN);
}

async function call(method, path, body) {
  if (!enabled()) throw new Error('VERCEL_TOKEN is not set.');
  const url = new URL(API + path);
  if (VERCEL_TEAM_ID) url.searchParams.set('teamId', VERCEL_TEAM_ID);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Vercel ${res.status}: ${json.error?.message || 'error'}`);
    e.code = json.error?.code;
    throw e;
  }
  return json;
}

// One Vercel project per client site, so each can carry its own custom domain.
function projectName(slug) {
  return `${VERCEL_PROJECT}-${slug}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 100);
}

// files: { 'index.html': string|Buffer, ... } -> { id, url }
async function deployStatic(slug, files) {
  const payload = Object.entries(files).map(([file, data]) => ({
    file,
    data: Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64'),
    encoding: 'base64'
  }));
  const d = await call('POST', '/v13/deployments', {
    name: projectName(slug),
    files: payload,
    target: 'production',
    projectSettings: { framework: null }
  });
  return { id: d.id, url: `https://${d.alias?.[0] || d.url}` };
}

// Attaches a custom domain. Returns what DNS records the domain needs, if any.
async function addDomain(slug, domain) {
  try {
    await call('POST', `/v10/projects/${encodeURIComponent(projectName(slug))}/domains`, { name: domain });
  } catch (e) {
    if (e.code !== 'domain_already_in_use' && e.code !== 'domain_already_exists') throw e;
  }
  const cfg = await call('GET', `/v6/domains/${encodeURIComponent(domain)}/config`);
  return {
    misconfigured: Boolean(cfg.misconfigured),
    instructions: domain.split('.').length > 2
      ? `CNAME ${domain} -> cname.vercel-dns.com`
      : `A ${domain} -> 76.76.21.21`
  };
}

module.exports = { enabled, deployStatic, addDomain, projectName };

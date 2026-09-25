'use strict';

const UA = 'SiteForgeAudit/0.1 (+website health check)';
const UA_TOKEN = 'siteforgeaudit';

// Returns true when robots.txt lets us fetch `path`. Missing / broken robots.txt = allowed.
function robotsAllows(robotsTxt, path = '/') {
  const groups = [];
  let current = null;
  for (const rawLine of String(robotsTxt || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) groups.push(current = { agents: [], rules: [] });
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.rules.push({ allow: key === 'allow', path: value });
    }
  }
  const pick = groups.find((g) => g.agents.some((a) => a !== '*' && UA_TOKEN.includes(a))) ||
    groups.find((g) => g.agents.includes('*'));
  if (!pick) return true;
  // Longest matching rule wins; empty Disallow means allow all.
  let best = null;
  for (const r of pick.rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}

module.exports = { robotsAllows, UA };

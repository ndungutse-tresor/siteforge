'use strict';
const { db, tx } = require('../core/db');
const vercel = require('./vercel');
const { suspendSite, restoreSite, liveSite } = require('./publish');

const GRACE_DAYS = 30;

const today = () => new Date().toISOString().slice(0, 10);

function addMonths(isoDate, months) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

function createClient(prospectId, o) {
  const p = db.prepare('SELECT * FROM prospects WHERE id = ?').get(prospectId);
  if (!p) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  return tx(() => {
    const c = db.prepare(`INSERT INTO clients (prospect_id, business_name, contact_name, phone, plan, setup_fee, monthly_fee, domain, next_invoice_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(p.id, o.business_name || p.name, o.contact_name || null,
      o.phone || p.contact_phone || null, o.plan === 'annual' ? 'annual' : 'monthly', Number(o.setup_fee) || 0,
      Number(o.monthly_fee) || 0, o.domain || null, today());
    db.prepare("UPDATE prospects SET stage = 'won', updated_at = datetime('now') WHERE id = ?").run(p.id);
    return c;
  });
}

// Records a MoMo payment and pushes the paid-until date forward.
async function recordPayment(clientId, { amount, momo_txid, months, note }) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!c) throw Object.assign(new Error('Client not found'), { status: 404 });
  const m = Number(months) || (c.plan === 'annual' ? 12 : 1);
  const from = c.next_invoice_at > today() ? c.next_invoice_at : today();
  const until = addMonths(from, m);
  tx(() => {
    db.prepare('INSERT INTO payments (client_id, amount, momo_txid, covers_until, note) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, Number(amount) || 0, momo_txid || null, until, note || null);
    db.prepare("UPDATE clients SET next_invoice_at = ?, status = 'active' WHERE id = ?").run(until, c.id);
  });
  if (c.status === 'suspended') await restoreSite(c);
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id);
}

// Daily: past due -> overdue; 30 days past due -> suspended (site replaced by a renew page).
async function checkRenewals() {
  const t = today();
  const graceCutoff = addDays(t, -GRACE_DAYS);
  const overdue = db.prepare("UPDATE clients SET status = 'overdue' WHERE status = 'active' AND next_invoice_at < ? RETURNING id").all(t);
  const toSuspend = db.prepare("SELECT * FROM clients WHERE status = 'overdue' AND next_invoice_at < ?").all(graceCutoff);
  for (const c of toSuspend) {
    await suspendSite(c);
    db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").run(c.id);
  }
  return { newly_overdue: overdue.length, suspended: toSuspend.length };
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function setDomain(clientId, domain) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!c) throw Object.assign(new Error('Client not found'), { status: 404 });
  const clean = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean)) throw Object.assign(new Error('Enter a domain like example.rw'), { status: 400 });
  let dns = null;
  if (vercel.enabled()) {
    const site = liveSite(c.prospect_id);
    if (!site) throw Object.assign(new Error('Deploy the site before adding a domain.'), { status: 409 });
    dns = await vercel.addDomain(site.slug, clean);
  }
  db.prepare('UPDATE clients SET domain = ?, live_url = ? WHERE id = ?').run(clean, `https://${clean}`, c.id);
  return { domain: clean, dns };
}

module.exports = { createClient, recordPayment, checkRenewals, setDomain, addMonths, GRACE_DAYS };

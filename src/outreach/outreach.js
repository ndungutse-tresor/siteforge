'use strict';
const { db, tx } = require('../core/db');
const { BRAND_NAME, OPT_OUT_CONTACT } = require('../core/config');
const { whatsappDigits } = require('../generation/brief');

const CHANNELS = ['visit', 'call', 'whatsapp', 'sms', 'email'];
// Channels that deliver a written marketing message (ICT Law 24/2016: must carry an opt-out).
const WRITTEN = new Set(['whatsapp', 'sms', 'email']);

class DoNotContactError extends Error {
  constructor() {
    super('This business asked not to be contacted.');
    this.status = 409;
  }
}

async function getProspect(id) {
  const p = await db.get('SELECT * FROM prospects WHERE id = ?', id);
  if (!p) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  return p;
}

function optOutLine(lang) {
  return lang === 'en'
    ? `To stop receiving messages from ${BRAND_NAME}: ${OPT_OUT_CONTACT}.`
    : `Niba udashaka kongera kwakira ubutumwa bwa ${BRAND_NAME}: ${OPT_OUT_CONTACT}. / To stop: ${OPT_OUT_CONTACT}.`;
}

// Draft message. The opt-out line is appended here and cannot be removed by editing.
async function composeMessage(prospectId, { lang = 'rw', previewUrl } = {}) {
  const p = await getProspect(prospectId);
  if (p.do_not_contact) throw new DoNotContactError();
  const url = previewUrl || (await db.get('SELECT preview_url FROM generated_sites WHERE prospect_id = ? ORDER BY version DESC LIMIT 1', p.id))?.preview_url;
  const body = lang === 'en'
    ? `Hello ${p.name}, I made a free sample website for your business${url ? `: ${url}` : ''}. If you like it, I can put it online under your own name, with hosting and updates included. — ${BRAND_NAME}`
    : `Muraho ${p.name}, nabakoreye icyitegererezo cy'urubuga rw'ubucuruzi bwanyu ku buntu${url ? `: ${url}` : ''}. Nimurukunda, nshobora kurushyira kuri interineti mu izina ryanyu, tukabyitaho buri kwezi. — ${BRAND_NAME}`;
  return { body, opt_out: optOutLine(lang), full: `${body}\n\n${optOutLine(lang)}` };
}

// Link that opens WhatsApp with the message ready; the admin presses send themselves.
async function whatsappLink(prospectId, opts) {
  const p = await getProspect(prospectId);
  const msg = await composeMessage(prospectId, opts);
  const to = whatsappDigits(p.contact_phone);
  if (!to) throw Object.assign(new Error('No usable phone number for WhatsApp.'), { status: 400 });
  return { url: `https://wa.me/${to}?text=${encodeURIComponent(msg.full)}`, message: msg.full };
}

async function logOutreach(prospectId, { channel, message, outcome }) {
  const p = await getProspect(prospectId);
  if (!CHANNELS.includes(channel)) throw Object.assign(new Error('Unknown channel'), { status: 400 });
  // An in-person visit after an opt-out is still blocked: the flag is never overridden.
  if (p.do_not_contact) throw new DoNotContactError();
  let text = message || null;
  if (WRITTEN.has(channel) && text && !text.includes(OPT_OUT_CONTACT)) text += `\n\n${optOutLine('rw')}`;
  return tx(async () => {
    const row = await db.get('INSERT INTO outreach_log (prospect_id, channel, message, outcome) VALUES (?, ?, ?, ?) RETURNING *',
      p.id, channel, text, outcome || null);
    await db.run(`UPDATE prospects SET stage = CASE WHEN stage IN ('discovered', 'audited', 'generated') THEN 'contacted' ELSE stage END,
      updated_at = now() WHERE id = ?`, p.id);
    return row;
  });
}

async function optOut(prospectId, note) {
  const p = await getProspect(prospectId);
  return tx(async () => {
    await db.run("UPDATE prospects SET do_not_contact = 1, stage = CASE WHEN stage = 'won' THEN stage ELSE 'lost' END, updated_at = now() WHERE id = ?", p.id);
    await db.run("INSERT INTO outreach_log (prospect_id, channel, outcome, opt_out_at) VALUES (?, 'note', ?, now())",
      p.id, note || 'Asked not to be contacted');
    return getProspect(p.id);
  });
}

module.exports = { CHANNELS, composeMessage, whatsappLink, logOutreach, optOut, optOutLine, DoNotContactError };

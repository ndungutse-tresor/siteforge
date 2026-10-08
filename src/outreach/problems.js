'use strict';
const { db } = require('../core/db');
const { BRAND_NAME } = require('../core/config');
const { normalizeUrl } = require('../scoring/auditor');
const { getResearch, usableEmails } = require('../research/collect');
const { whatsappDigits } = require('../generation/brief');
const { optOutLine, DoNotContactError } = require('./outreach');

// Turns an audit into what a business owner understands: each problem, what it costs them,
// what would fix it, and the evidence behind it. Used by the admin before deciding to contact them.

const SEVERITY = { critical: 3, high: 2, medium: 1 };

// Text for each problem. {domain}, {code}, {seconds}, {year}, {tech}, {email} are filled in from the audit.
// rw is the short version used in the Kinyarwanda message; read it before sending.
const PROBLEMS = {
  none: {
    severity: 'critical', service: 'new-website',
    problem: 'No website',
    consequence: 'Customers who search on Google or Google Maps find competitors first. Tourists, companies and NGOs usually check a website before they call, book or buy.',
    fix: 'A simple website with services, hours, map and call / WhatsApp buttons.',
    rw: ['Nta rubuga rwa interineti mufite', 'abakiriya babashakira kuri Google cyangwa Google Maps babona abandi mbere yanyu.']
  },
  'dns-dead': {
    severity: 'critical', service: 'domain-email',
    problem: 'Your web address {domain} no longer works',
    consequence: 'Anyone who types it or clicks it on Google Maps, business cards or booking sites gets an error page, and may think you have closed.',
    fix: 'Renew or replace the domain and put a working website on it.',
    rw: ['Aderesi y\'urubuga rwanyu ({domain}) ntigikora', 'abayifungura babona ikosa, bashobora gutekereza ko mwafunze.']
  },
  'taken-over': {
    severity: 'critical', service: 'domain-email',
    problem: 'Your old web address {domain} now shows someone else\'s site',
    consequence: 'Customers who look you up land on spam or gambling content under your name. That damages trust in your business, and Google may link your name to it.',
    fix: 'A new domain and website, and removing the old address from Google Maps and directories.',
    rw: ['Aderesi y\'urubuga rwanyu ({domain}) ubu igaragaza urubuga rw\'abandi', 'abakiriya babashakira bahura n\'ibintu bitabareba, bigatesha agaciro izina ryanyu.']
  },
  parked: {
    severity: 'high', service: 'new-website',
    problem: 'Your web address {domain} shows an empty or "for sale" page',
    consequence: 'Visitors see a placeholder instead of your business, and leave without your phone number, prices or location.',
    fix: 'Put a real website on the domain you already own.',
    rw: ['Aderesi y\'urubuga rwanyu ({domain}) igaragaza urupapuro rudafite amakuru yanyu', 'abakiriya ntibabona telefoni, ibiciro cyangwa aho muherereye.']
  },
  'social-only': {
    severity: 'high', service: 'new-website',
    problem: 'Only a social media page, no website',
    consequence: 'People without Facebook or Instagram, or who search on Google, struggle to find your prices, hours and directions. The platform controls your page, and posts get buried.',
    fix: 'A website you own, linked to your social pages.',
    rw: ['Mufite urupapuro rwa Facebook cyangwa Instagram gusa', 'abatari kuri izo mbuga cyangwa bashakira kuri Google ntibabona byoroshye ibiciro, amasaha n\'aho muherereye.']
  },
  'invalid-url': {
    severity: 'high', service: 'new-website',
    problem: 'The website listed for you is not a real web address',
    consequence: 'Maps and directories send customers to a broken link.',
    fix: 'A working website, and correct links on Google Maps and directories.',
    rw: ['Aderesi y\'urubuga yanditse kuri mwe si aderesi nyayo', 'abakiriya bayikanda ntibabageraho.']
  },
  'ssl-error': {
    severity: 'critical', service: 'website-update',
    problem: 'Browsers show a security warning on your website',
    consequence: 'Chrome and phones display "Your connection is not private" before your site opens. Most visitors turn back at that point.',
    fix: 'A valid security certificate (HTTPS) that renews itself.',
    rw: ['Urubuga rwanyu rugaragaza ubutumwa bw\'umutekano ("Not private")', 'abenshi bahita basubira inyuma batarureba.']
  },
  timeout: {
    severity: 'critical', service: 'website-update',
    problem: 'Your website does not load',
    consequence: 'Visitors wait and give up. Google drops sites that don\'t load from its results.',
    fix: 'Move the site to reliable hosting or rebuild it.',
    rw: ['Urubuga rwanyu ntirufunguka', 'abakiriya bategereza bakarureka, kandi Google irukura mu byo yerekana.']
  },
  unreachable: {
    severity: 'critical', service: 'website-update',
    problem: 'Your website does not load',
    consequence: 'Visitors wait and give up. Google drops sites that don\'t load from its results.',
    fix: 'Move the site to reliable hosting or rebuild it.',
    rw: ['Urubuga rwanyu ntirufunguka', 'abakiriya bategereza bakarureka, kandi Google irukura mu byo yerekana.']
  },
  http_error: {
    severity: 'critical', service: 'website-update',
    problem: 'Your website shows an error page ({code})',
    consequence: 'Visitors see an error instead of your business and leave.',
    fix: 'Repair or rebuild the site.',
    rw: ['Urubuga rwanyu rugaragaza ikosa ({code})', 'abakiriya ntibabona amakuru bashaka bakagenda.']
  },
  dead_email: {
    severity: 'high', service: 'domain-email',
    problem: 'Your email address {email} probably no longer works',
    consequence: 'Its domain has expired, so emails from customers, suppliers and booking sites bounce back and never reach you.',
    fix: 'A working business email on your own domain.',
    rw: ['Email yanyu {email} ishobora kuba itagikora', 'ubutumwa bw\'abakiriya n\'abafatanyabikorwa busubira inyuma butabagezeho.']
  },
  not_mobile: {
    severity: 'high', service: 'website-update',
    problem: 'Your website is hard to use on a phone',
    consequence: 'Most people in Rwanda browse on their phones. They have to zoom and scroll sideways, and many leave.',
    fix: 'A mobile-friendly layout.',
    rw: ['Urubuga rwanyu ntirugaragara neza kuri telefoni', 'abenshi barureba kuri telefoni; bagomba kwagura no kunyereza, bakarureka.']
  },
  no_https: {
    severity: 'high', service: 'website-update',
    problem: 'Your website is marked "Not secure"',
    consequence: 'It has no HTTPS, so browsers warn visitors, anything typed into it can be read on the way, and Google ranks it lower.',
    fix: 'HTTPS with a free certificate that renews itself.',
    rw: ['Urubuga rwanyu rwanditseho "Not secure"', 'nta HTTPS rufite, browser ziburira abarusura, kandi Google irushyira inyuma.']
  },
  no_contact: {
    severity: 'medium', service: 'website-update',
    problem: 'No tap-to-call, WhatsApp or email link on your website',
    consequence: 'A visitor who is ready to buy has to copy your number by hand, or can\'t find it at all.',
    fix: 'Call and WhatsApp buttons on every page.',
    rw: ['Nta buryo bwihuse bwo kubavugisha (telefoni, WhatsApp, email) buri ku rubuga', 'umukiriya ushaka kugura ntabageraho mu kanya gato.']
  },
  slow: {
    severity: 'medium', service: 'website-update',
    problem: 'Your website takes {seconds} seconds to start loading',
    consequence: 'Visitors on mobile data give up before it opens, and Google ranks slow sites lower.',
    fix: 'Faster hosting and lighter pages.',
    rw: ['Urubuga rwanyu rutinda gufunguka (amasegonda {seconds})', 'abakoresha interineti ya telefoni barureka rutarafunguka.']
  },
  old_copyright: {
    severity: 'medium', service: 'website-update',
    problem: 'Your website looks abandoned (last dated {year})',
    consequence: 'Visitors wonder whether you are still open, and whether the prices and phone numbers are still right.',
    fix: 'Fresh content and a site you can keep up to date.',
    rw: ['Urubuga rwanyu rugaragara nk\'urwatereranywe (rwanditseho {year})', 'abakiriya bibaza niba mukiri gukora n\'amakuru ariho niba akiri ukuri.']
  },
  obsolete_tech: {
    severity: 'medium', service: 'website-update',
    problem: 'Your website is built on outdated technology ({tech})',
    consequence: 'Old code has known security holes that attackers look for, and it can break in new browsers.',
    fix: 'Rebuild on current, maintained technology.',
    rw: ['Urubuga rwanyu rwubakishije ikoranabuhanga rishaje ({tech})', 'rushobora kwibasirwa n\'abajura bo kuri interineti cyangwa kwangirika muri browser nshya.']
  }
};

const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (_, k) => (v[k] != null && v[k] !== '' ? v[k] : '?'));

function hostOf(url) {
  try { return normalizeUrl(url)?.hostname.replace(/^www\./, '') || ''; } catch (e) { return ''; }
}

// The latest audit plus what it means. Returns { status, checked_at, issues[], unchecked }.
async function diagnose(prospect) {
  const a = await db.get('SELECT * FROM audits WHERE prospect_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1', prospect.id);
  const status = prospect.website_status;
  if (!a || !status) return { status: null, checked_at: null, issues: [], unchecked: 'Not audited yet. Run the audit on the Overview tab first.' };
  if (status === 'blocked' || status === 'robots-blocked') {
    return { status, checked_at: a.checked_at, issues: [], unchecked: 'Their site blocks automatic checks, so we could not look at it. Open it in a browser and judge it yourself.' };
  }
  let signals = {};
  try { signals = JSON.parse(a.signals || '{}'); } catch (e) { /* keep empty */ }
  const notes = signals.notes || [];
  const vars = {
    domain: hostOf(prospect.website_url) || 'your domain',
    code: a.http_status || status.replace(/^http-/, ''),
    seconds: a.load_ms ? (a.load_ms / 1000).toFixed(1) : null,
    year: a.last_copyright_year,
    tech: (notes.find((n) => /^Obsolete:/.test(n)) || '').replace(/^Obsolete:\s*/, '') || 'old code'
  };

  const keys = [];
  if (PROBLEMS[status]) keys.push(status);
  else if (/^http-\d+$/.test(status)) keys.push('http_error');
  if (status === 'live' || status === 'taken-over') {
    for (const k of ['not_mobile', 'no_https', 'no_contact', 'slow', 'old_copyright', 'obsolete_tech']) {
      if (signals[k] && !(status === 'taken-over' && k === 'no_https')) keys.push(k);
    }
  }
  // An email on the business's own dead domain will bounce.
  const found = (await getResearch(prospect.id))?.found;
  const emails = [prospect.contact_email, ...(found?.emails || []), ...(found?.dropped_emails || [])].filter(Boolean);
  const deadEmail = status === 'dns-dead' && emails.find((e) => !usableEmails([e], prospect).length);
  if (deadEmail) keys.push('dead_email');

  const evidence = {
    none: 'No website on OpenStreetMap, the RDB list or their own records.',
    'dns-dead': notes.find((n) => /^DNS/.test(n)) || 'The domain does not resolve.',
    'taken-over': notes.find((n) => /never mentions/.test(n)) || a.final_url,
    parked: a.final_url ? `${a.final_url} shows a parked or default page.` : null,
    'social-only': prospect.website_url,
    'invalid-url': `Listed as "${prospect.website_url}".`,
    'ssl-error': notes.filter((n) => /TLS|CERT/.test(n)).join(' · ') || null,
    timeout: notes.join(' · ') || null,
    unreachable: notes.join(' · ') || null,
    http_error: a.final_url ? `${a.final_url} answered HTTP ${a.http_status}.` : null,
    dead_email: deadEmail ? `${deadEmail} is on the expired domain ${vars.domain}.` : null,
    not_mobile: 'No mobile viewport, or a fixed desktop-width layout.',
    no_https: notes.find((n) => /^(TLS|HTTPS):/.test(n)) || (a.final_url ? `Opens as ${a.final_url}` : null),
    no_contact: 'No tel:, WhatsApp or mailto: link and no Rwandan phone number in the page.',
    slow: vars.seconds ? `First byte after ${vars.seconds} s.` : null,
    old_copyright: vars.year ? `Latest copyright year on the page: ${vars.year}.` : null,
    obsolete_tech: notes.find((n) => /^Obsolete:/.test(n)) || null
  };

  const issues = keys.map((k) => {
    const p = PROBLEMS[k];
    return {
      key: k, severity: p.severity, service: p.service,
      problem: fill(p.problem, { ...vars, email: deadEmail }),
      consequence: fill(p.consequence, { ...vars, email: deadEmail }),
      fix: p.fix,
      evidence: evidence[k] || null,
      rw: [fill(p.rw[0], { ...vars, email: deadEmail }), fill(p.rw[1], { ...vars, email: deadEmail })]
    };
  }).sort((x, y) => SEVERITY[y.severity] - SEVERITY[x.severity]);
  return { status, checked_at: a.checked_at, issues, unchecked: null };
}

// Where we can reach them: a phone that works on WhatsApp and an email that won't bounce.
async function contactOptions(prospect) {
  const found = (await getResearch(prospect.id))?.found || {};
  const phone = prospect.contact_phone || found.phones?.[0] || '';
  const email = usableEmails([prospect.contact_email, ...(found.emails || [])].filter(Boolean), prospect)[0] || '';
  return { phone, whatsapp: whatsappDigits(phone), email };
}

// A support message listing the problems. The stop line is always added (ICT Law 24/2016).
function composeProblemMessage(prospect, issues, lang = 'en') {
  if (prospect.do_not_contact) throw new DoNotContactError();
  const n = issues.length;
  const top = issues.slice(0, 5);
  let subject, body;
  if (lang === 'rw') {
    subject = `${prospect.name}: ibibazo ku rubuga rwanyu`;
    body = [
      `Muraho ${prospect.name},`,
      '',
      `Nasuzumye uko ubucuruzi bwanyu bugaragara kuri interineti, mbona ${n === 1 ? 'ikibazo kimwe gishobora' : `ibibazo ${n} bishobora`} gutuma mutakaza abakiriya:`,
      '',
      ...top.map((x, i) => `${i + 1}. ${x.rw[0]}: ${x.rw[1]}`),
      '',
      'Nshobora kubafasha kubikemura. Munsubize hano niba mwifuza ko tubiganiraho.',
      '',
      `— ${BRAND_NAME}`
    ].join('\n');
  } else {
    subject = issues[0]?.key === 'none'
      ? `${prospect.name}: customers can't find you online`
      : `${prospect.name}: ${n === 1 ? 'a problem' : `${n} problems`} with your website`;
    body = [
      `Hello ${prospect.name},`,
      '',
      `I checked how your business appears online and found ${n === 1 ? 'one problem' : `${n} problems`} that may be costing you customers:`,
      '',
      ...top.map((x, i) => `${i + 1}. ${x.problem}. ${x.consequence}`),
      '',
      'I can fix this for you. Reply to this message if you would like to talk about it.',
      '',
      `— ${BRAND_NAME}`
    ].join('\n');
  }
  const stop = optOutLine(lang === 'rw' ? 'rw' : 'en');
  return { subject, body, stop, full: `${body}\n\n${stop}` };
}

const FREE_MAIL = /@(gmail|yahoo|ymail|hotmail|outlook|live|icloud|aol|protonmail|mail)\./i;

// Notes for the admin only, never put in the message.
function warningsFor(prospect, d, contacts) {
  const out = [];
  const email = contacts.email || prospect.contact_email || '';
  if (d.status === 'none' && email && !FREE_MAIL.test(email)) {
    const domain = email.split('@')[1];
    out.push(`Their email is on ${domain}. They may already have a website at https://${domain}/ that the listing doesn't show. Check it before saying they have no website.`);
  }
  if (!contacts.whatsapp && !contacts.email) {
    out.push('No phone or email on file. Get one on a visit, or look them up live on the Google tab.');
  }
  if (/07xx/.test(optOutLine('en'))) {
    out.push('The stop line still has the placeholder number. Set OPT_OUT_CONTACT in .env before sending messages.');
  }
  return out;
}

async function problemReport(prospectId) {
  const p = await db.get('SELECT * FROM prospects WHERE id = ?', prospectId);
  if (!p) throw Object.assign(new Error('Prospect not found'), { status: 404 });
  const d = await diagnose(p);
  const contacts = await contactOptions(p);
  const messages = d.issues.length && !p.do_not_contact
    ? { en: composeProblemMessage(p, d.issues, 'en'), rw: composeProblemMessage(p, d.issues, 'rw') } : null;
  return { ...d, contacts, messages, warnings: warningsFor(p, d, contacts), do_not_contact: Boolean(p.do_not_contact) };
}

module.exports = { PROBLEMS, diagnose, contactOptions, composeProblemMessage, problemReport };

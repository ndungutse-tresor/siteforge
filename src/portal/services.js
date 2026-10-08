'use strict';
const { db } = require('../core/db');

// What clients can order. Prices are set by the admin; a service without a price is never shown.
const SEED = [
  { slug: 'new-website', name: 'New business website', delivery_days: 14,
    description: 'A fast, mobile-friendly website for your business in Kinyarwanda and English, with your services, opening hours, map, and call and WhatsApp buttons.',
    i18n: {
      rw: { name: 'Urubuga rushya rw\'ubucuruzi', description: 'Urubuga rwihuta kandi rukora neza kuri telefoni, mu Kinyarwanda no mu Cyongereza, rugaragaza serivisi zanyu, amasaha mukoreraho, ikarita, n\'utubuto two guhamagara no kwandika kuri WhatsApp.' },
      fr: { name: 'Nouveau site web d\'entreprise', description: 'Un site rapide et adapté aux téléphones, en kinyarwanda et en anglais, avec vos services, vos horaires, un plan d\'accès et des boutons d\'appel et WhatsApp.' } } },
  { slug: 'website-update', name: 'Website update or redesign', delivery_days: 10,
    description: 'We rebuild or fix your current website so it is secure (HTTPS), works well on phones, and shows up-to-date information.',
    i18n: {
      rw: { name: 'Kuvugurura urubuga', description: 'Tuvugurura cyangwa tugakosora urubuga mufite kugira ngo rugire umutekano (HTTPS), rukore neza kuri telefoni, kandi rugaragaze amakuru agezweho.' },
      fr: { name: 'Mise à jour ou refonte de site', description: 'Nous reconstruisons ou corrigeons votre site actuel pour qu\'il soit sécurisé (HTTPS), fonctionne bien sur téléphone et affiche des informations à jour.' } } },
  { slug: 'domain-email', name: '.rw domain and business email', delivery_days: 5,
    description: 'Your own .rw web address and a professional email such as info@yourbusiness.rw, set up and connected.',
    i18n: {
      rw: { name: 'Izina rya .rw na email y\'ubucuruzi', description: 'Aderesi yanyu bwite ya .rw na email y\'umwuga nka info@ubucuruzibwanyu.rw, tubitunganya kandi tukabihuza.' },
      fr: { name: 'Domaine .rw et e-mail professionnel', description: 'Votre propre adresse .rw et un e-mail professionnel comme info@votreentreprise.rw, configurés et connectés.' } } },
  { slug: 'hosting', name: 'Hosting and monthly updates', delivery_days: 3,
    description: 'We keep your website online, secure and backed up, and make small changes for you each month.',
    i18n: {
      rw: { name: 'Kubika urubuga no kuruvugurura buri kwezi', description: 'Dutuma urubuga rwanyu ruhora kuri interineti, rufite umutekano kandi rubitswe neza, kandi tubakorera impinduka nto buri kwezi.' },
      fr: { name: 'Hébergement et mises à jour mensuelles', description: 'Nous gardons votre site en ligne, sécurisé et sauvegardé, et faisons de petites modifications pour vous chaque mois.' } } },
  { slug: 'it-support', name: 'IT support', delivery_days: 3,
    description: 'Help with computers, networks, printers, software and accounts for your business.',
    i18n: {
      rw: { name: 'Ubufasha mu ikoranabuhanga (IT)', description: 'Ubufasha kuri mudasobwa, imiyoboro ya interineti, imashini zisohora impapuro, porogaramu na konti by\'ubucuruzi bwanyu.' },
      fr: { name: 'Support informatique', description: 'Aide pour les ordinateurs, les réseaux, les imprimantes, les logiciels et les comptes de votre entreprise.' } } },
  { slug: 'chatbot', name: 'Chatbot for your business', delivery_days: 14,
    description: 'An assistant on your website or WhatsApp that answers common customer questions day and night.',
    i18n: {
      rw: { name: 'Chatbot y\'ubucuruzi bwanyu', description: 'Umufasha uri ku rubuga rwanyu cyangwa kuri WhatsApp, usubiza ibibazo abakiriya bakunze kubaza, ku manywa na nijoro.' },
      fr: { name: 'Chatbot pour votre entreprise', description: 'Un assistant sur votre site ou sur WhatsApp qui répond jour et nuit aux questions fréquentes de vos clients.' } } }
];

const LANGS = ['rw', 'fr'];

async function seedServices() {
  // New catalogs get the six services; services created before translations existed get them,
  // unless the admin has written their own.
  for (const [i, s] of SEED.entries()) {
    await db.run(`INSERT INTO services (slug, name, description, delivery_days, sort, i18n) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (slug) DO NOTHING`, s.slug, s.name, s.description, s.delivery_days, (i + 1) * 10, JSON.stringify(s.i18n || {}));
    await db.run("UPDATE services SET i18n = ? WHERE slug = ? AND (i18n IS NULL OR i18n = '{}')", JSON.stringify(s.i18n || {}), s.slug);
  }
}
// Runs once per server instance, the first time the catalog is used.
let seeded = null;
const ensureSeeded = () => (seeded ||= seedServices().catch((e) => { seeded = null; throw e; }));

const parseI18n = (v) => { try { return JSON.parse(v || '{}'); } catch (e) { return {}; } };

// Keep only rw / fr names and descriptions, trimmed to the same limits as the English ones.
function cleanI18n(input, current) {
  const out = { ...current };
  for (const l of LANGS) {
    if (!input || input[l] === undefined) continue;
    const name = String(input[l]?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const description = String(input[l]?.description || '').trim().slice(0, 600);
    if (name || description) out[l] = { name, description }; else delete out[l];
  }
  return out;
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// What clients see.
async function listActive() {
  await ensureSeeded();
  return (await db.all(`SELECT id, slug, name, description, price, delivery_days, i18n FROM services
    WHERE active = 1 AND price > 0 ORDER BY sort, name`)).map((s) => ({ ...s, i18n: parseI18n(s.i18n) }));
}

async function listAll() {
  await ensureSeeded();
  return (await db.all(`SELECT s.*, (SELECT COUNT(*) FROM orders o WHERE o.service_id = s.id) AS orders
    FROM services s ORDER BY s.sort, s.name`)).map((s) => ({ ...s, i18n: parseI18n(s.i18n) }));
}

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'service';
}

// Create (no id) or update a service. Only fields that are sent are changed.
async function saveService(id, b) {
  await ensureSeeded();
  const cur = id ? await db.get('SELECT * FROM services WHERE id = ?', id) : null;
  if (id && !cur) throw fail(404, 'Service not found.');
  const next = { ...(cur || { description: '', price: null, delivery_days: null, active: 0, sort: 1000 }) };
  next.i18n = cleanI18n(b.i18n, parseI18n(cur?.i18n));
  if (b.name !== undefined) next.name = String(b.name).replace(/\s+/g, ' ').trim().slice(0, 80);
  if (b.description !== undefined) next.description = String(b.description).trim().slice(0, 600);
  if (b.price !== undefined) {
    const p = b.price === '' || b.price === null ? null : Number(b.price);
    if (p !== null && (!Number.isInteger(p) || p < 0 || p > 100000000)) throw fail(400, 'Price must be a whole number of RWF.');
    next.price = p;
  }
  if (b.delivery_days !== undefined) {
    const d = b.delivery_days === '' || b.delivery_days === null ? null : Number(b.delivery_days);
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 365)) throw fail(400, 'Delivery time must be 1 to 365 days.');
    next.delivery_days = d;
  }
  if (b.sort !== undefined) next.sort = Number(b.sort) || 0;
  if (b.active !== undefined) next.active = b.active ? 1 : 0;
  if (!next.name) throw fail(400, 'Give the service a name.');
  if (next.active && !(next.price > 0)) throw fail(400, 'Set a price before showing this service to clients.');

  if (cur) {
    await db.run('UPDATE services SET name = ?, description = ?, price = ?, delivery_days = ?, active = ?, sort = ?, i18n = ? WHERE id = ?',
      next.name, next.description, next.price, next.delivery_days, next.active, next.sort, JSON.stringify(next.i18n), cur.id);
    const row = await db.get('SELECT * FROM services WHERE id = ?', cur.id);
    return { ...row, i18n: parseI18n(row.i18n) };
  }
  let slug = slugify(next.name), n = 2;
  while (await db.get('SELECT 1 FROM services WHERE slug = ?', slug)) slug = `${slugify(next.name)}-${n++}`;
  const row = await db.get(`INSERT INTO services (slug, name, description, price, delivery_days, active, sort, i18n)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`, slug, next.name, next.description, next.price, next.delivery_days, next.active, next.sort, JSON.stringify(next.i18n));
  return { ...row, i18n: parseI18n(row.i18n) };
}

module.exports = { listActive, listAll, saveService, seedServices, ensureSeeded, SEED };

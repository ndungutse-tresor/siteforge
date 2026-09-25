'use strict';
const { sectorFromOsm } = require('./sectors');

// OpenStreetMap data (ODbL) can be stored, unlike Google Places content.
// Attribution "© OpenStreetMap contributors" is shown in the admin panel.
// The main server is often overloaded (504/429), so fall back to public mirrors.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

// Kigali city, roughly. south, west, north, east.
const KIGALI_BBOX = [-2.08, 29.97, -1.86, 30.25];

function overpassQuery([s, w, n, e]) {
  const box = `(${s},${w},${n},${e})`;
  const kinds = ['shop', 'office', 'tourism', 'healthcare', 'craft'];
  const amenities = 'clinic|hospital|doctors|dentist|pharmacy|school|college|university|kindergarten|language_school|driving_school|restaurant|cafe|fast_food|bar|car_repair';
  const parts = kinds.map((k) => `nwr["name"]["${k}"]${box};`);
  parts.push(`nwr["name"]["amenity"~"^(${amenities})$"]${box};`);
  return `[out:json][timeout:120];(${parts.join('')});out center tags;`;
}

// Very rough split of Kigali into its three districts; OSM rarely carries addr:district.
function guessDistrict(lat, lng) {
  if (lat == null || lng == null) return null;
  if (lng < 30.07) return 'Nyarugenge';
  if (lat < -1.965) return 'Kicukiro';
  return 'Gasabo';
}

function normalize(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lng = el.lon ?? el.center?.lon ?? null;
  return {
    osm_id: `${el.type}/${el.id}`,
    name: t.name,
    sector: sectorFromOsm(t),
    district: t['addr:district'] || guessDistrict(lat, lng),
    sector_admin: t['addr:subdistrict'] || t['addr:suburb'] || null,
    lat, lng,
    website_url: t.website || t['contact:website'] || t['contact:facebook'] || null,
    contact_phone: t.phone || t['contact:phone'] || null,
    contact_email: t.email || t['contact:email'] || null,
    contact_source: 'osm',
    osm_tags: t
  };
}

async function fetchOsm(bbox = KIGALI_BBOX) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  const errors = [];
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'siteforge-prospecting/0.1' },
        body,
        signal: AbortSignal.timeout(180000)
      });
      if (res.ok) return parseOsm(await res.json());
      errors.push(`${new URL(url).host} returned ${res.status}`);
      if (res.status !== 429 && res.status < 500) break; // a bad query fails everywhere
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err.message}`);
    }
  }
  throw new Error(`Overpass failed (${errors.join('; ')})`);
}

function parseOsm(json) {
  return (json.elements || []).filter((el) => el.tags && el.tags.name).map(normalize);
}

module.exports = { fetchOsm, parseOsm, overpassQuery, KIGALI_BBOX };

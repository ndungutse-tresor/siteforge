'use strict';
const { GOOGLE_PLACES_API_KEY } = require('../core/config');
const { db } = require('../core/db');

// Google Places API (New). Terms allow storing place_id indefinitely and lat/lng for 30 days;
// everything else must be fetched live and shown with Google attribution. So these
// functions return data for display and store nothing except place_id (and coords,
// stamped for the 30-day purge in compliance/purge.js).
const BASE = 'https://places.googleapis.com/v1';
const DETAIL_FIELDS = 'id,displayName,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,websiteUri,rating,userRatingCount,businessStatus,regularOpeningHours.weekdayDescriptions,googleMapsUri,location';

function enabled() {
  return Boolean(GOOGLE_PLACES_API_KEY);
}

async function call(path, { method = 'GET', body, fields }) {
  if (!enabled()) throw new Error('GOOGLE_PLACES_API_KEY is not set.');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'X-Goog-Api-Key': GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask': fields,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Places API ${res.status}: ${json.error?.message || 'error'}`);
  return json;
}

// Live details for display. Never write the result to the database.
async function placeDetails(placeId) {
  const p = await call(`/places/${encodeURIComponent(placeId)}`, { fields: DETAIL_FIELDS });
  return {
    place_id: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber,
    website: p.websiteUri || null,
    rating: p.rating,
    ratings: p.userRatingCount,
    status: p.businessStatus,
    hours: p.regularOpeningHours?.weekdayDescriptions || [],
    maps_url: p.googleMapsUri,
    location: p.location,
    attribution: 'Data © Google'
  };
}

// Candidates for linking a prospect to a place_id. The admin picks the right one.
async function findCandidates(name, district) {
  const json = await call('/places:searchText', {
    method: 'POST',
    fields: 'places.id,places.displayName,places.formattedAddress',
    body: {
      textQuery: `${name} ${district || ''} Kigali Rwanda`.trim(),
      regionCode: 'RW',
      locationBias: { circle: { center: { latitude: -1.9536, longitude: 30.0606 }, radius: 30000 } },
      pageSize: 5
    }
  });
  return (json.places || []).map((p) => ({ place_id: p.id, name: p.displayName?.text, address: p.formattedAddress }));
}

function linkPlace(prospectId, placeId, location) {
  const sets = ['place_id = ?'], vals = [placeId];
  if (location && typeof location.latitude === 'number') {
    sets.push('lat = ?', 'lng = ?', "coords_source = 'google'", "coords_fetched_at = datetime('now')");
    vals.push(location.latitude, location.longitude);
  }
  db.prepare(`UPDATE prospects SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals, prospectId);
}

// Website to audit: the business's own URL if we have one, otherwise Google's, live.
// Returns { url, source } where url may be null (= no website at all).
async function resolveWebsite(prospect) {
  if (prospect.website_url) return { url: prospect.website_url, source: prospect.contact_source || 'stored' };
  if (prospect.place_id && enabled()) {
    const d = await placeDetails(prospect.place_id);
    return { url: d.website, source: 'google-live' };
  }
  return { url: null, source: prospect.place_id ? 'unknown' : 'none-recorded' };
}

module.exports = { enabled, placeDetails, findCandidates, linkPlace, resolveWebsite };

'use strict';

// Sector = what the business does. `wtp` is the willingness-to-pay multiplier applied to
// the website score: a dead site for a tour operator outranks no site for a salon.
// `template` picks the site design in generation/templates.
const SECTORS = {
  hotel:        { label: 'Hotel / lodge',        wtp: 1.0,  template: 'hospitality' },
  restaurant:   { label: 'Restaurant / café',    wtp: 0.7,  template: 'hospitality' },
  clinic:       { label: 'Clinic / pharmacy',    wtp: 1.0,  template: 'clinic' },
  law:          { label: 'Law firm',             wtp: 1.0,  template: 'professional' },
  accounting:   { label: 'Accounting / consult', wtp: 0.9,  template: 'professional' },
  school:       { label: 'School / training',    wtp: 0.95, template: 'school' },
  tours:        { label: 'Tour operator',        wtp: 1.0,  template: 'tours' },
  real_estate:  { label: 'Real estate',          wtp: 0.95, template: 'professional' },
  construction: { label: 'Construction',         wtp: 0.9,  template: 'construction' },
  garage:       { label: 'Garage / auto',        wtp: 0.6,  template: 'construction' },
  retail:       { label: 'Shop / retail',        wtp: 0.5,  template: 'retail' },
  salon:        { label: 'Salon / beauty',       wtp: 0.45, template: 'retail' },
  kiosk:        { label: 'Kiosk / street shop',  wtp: 0.15, template: 'generic' },
  generic:      { label: 'Other',                wtp: 0.5,  template: 'generic' }
};

// OSM tag -> sector. First match wins, so specific tags come first.
const OSM_RULES = [
  [['tourism', /^(hotel|guest_house|motel|hostel|apartment)$/], 'hotel'],
  [['office', /^travel_agent$/], 'tours'],
  [['shop', /^travel_agency$/], 'tours'],
  [['amenity', /^(clinic|hospital|doctors|dentist|pharmacy)$/], 'clinic'],
  [['healthcare', /.+/], 'clinic'],
  [['office', /^(lawyer|notary)$/], 'law'],
  [['office', /^(accountant|consulting|tax_advisor|financial)$/], 'accounting'],
  [['office', /^estate_agent$/], 'real_estate'],
  [['amenity', /^(school|college|university|kindergarten|language_school|driving_school)$/], 'school'],
  [['amenity', /^(restaurant|cafe|fast_food|bar|pub)$/], 'restaurant'],
  [['office', /^(construction|architect|engineer)$/], 'construction'],
  [['craft', /^(builder|carpenter|electrician|plumber|metal_construction)$/], 'construction'],
  [['shop', /^(car|car_repair|car_parts|tyres)$/], 'garage'],
  [['amenity', /^car_repair$/], 'garage'],
  [['shop', /^(hairdresser|beauty|cosmetics)$/], 'salon'],
  [['shop', /^(kiosk|convenience|mobile_phone_accessories)$/], 'kiosk'],
  [['shop', /.+/], 'retail']
];

function sectorFromOsm(tags) {
  for (const [[k, re], sector] of OSM_RULES) if (tags[k] && re.test(tags[k])) return sector;
  return 'generic';
}

// Keyword guess for RDB rows or manual entries, which only have a name / activity text.
const KEYWORDS = [
  [/hotel|lodge|guest ?house|motel|resort|inn\b/i, 'hotel'],
  [/tour|safari|travel|gorilla/i, 'tours'],
  [/clinic|hospital|pharma|dental|medical|health|polyclinic/i, 'clinic'],
  [/law|advocate|legal|chambers|notary/i, 'law'],
  [/account|audit|consult|tax/i, 'accounting'],
  [/school|academy|college|institute|training|ecole|ishuri/i, 'school'],
  [/real estate|property|properties|immobili/i, 'real_estate'],
  [/construct|builder|engineering|architect/i, 'construction'],
  [/restaurant|cafe|café|coffee|grill|bistro|resto/i, 'restaurant'],
  [/garage|auto|motors|tyre|car /i, 'garage'],
  [/salon|beauty|spa|barber/i, 'salon'],
  [/shop|store|boutique|supermarket|market|alimentation/i, 'retail']
];

function sectorFromText(text) {
  for (const [re, sector] of KEYWORDS) if (re.test(text || '')) return sector;
  return 'generic';
}

function sectorInfo(key) {
  return SECTORS[key] || SECTORS.generic;
}

module.exports = { SECTORS, sectorFromOsm, sectorFromText, sectorInfo };

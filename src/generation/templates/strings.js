'use strict';

// Fixed interface words on every site. The body copy comes from the content schema.
const STRINGS = {
  rw: {
    name: 'Kinyarwanda', about: 'Abo turi bo', services: 'Serivisi zacu', why: 'Impamvu mwaduhitamo',
    gallery: 'Amafoto', hours: "Amasaha y'akazi", contact: 'Twandikire', findUs: 'Aho dukorera',
    call: 'Hamagara', whatsapp: 'WhatsApp', email: 'Imeri', map: 'Reba ku ikarita',
    preview: 'Icyitegererezo – ntikiratangazwa', madeBy: 'Urubuga rwakozwe na'
  },
  en: {
    name: 'English', about: 'About us', services: 'Our services', why: 'Why choose us',
    gallery: 'Photos', hours: 'Opening hours', contact: 'Contact us', findUs: 'Find us',
    call: 'Call', whatsapp: 'WhatsApp', email: 'Email', map: 'Open in map',
    preview: 'Sample – not yet published', madeBy: 'Website by'
  },
  fr: {
    name: 'Français', about: 'À propos', services: 'Nos services', why: 'Pourquoi nous choisir',
    gallery: 'Photos', hours: 'Horaires', contact: 'Contact', findUs: 'Nous trouver',
    call: 'Appeler', whatsapp: 'WhatsApp', email: 'E-mail', map: 'Voir sur la carte',
    preview: 'Aperçu – pas encore publié', madeBy: 'Site réalisé par'
  }
};

module.exports = { STRINGS };

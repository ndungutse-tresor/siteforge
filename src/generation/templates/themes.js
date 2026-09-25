'use strict';

// One hand-built layout, eight sector designs. A fix in layout.js reaches every client site.
// hero: 'split' (text + photo side by side), 'center' (text over tinted band), 'banner' (photo behind text)
// order: which sections appear and in what order.
const THEMES = {
  hospitality: {
    label: 'Hospitality (hotel, lodge, restaurant)',
    font: 'serif',
    hero: 'banner',
    order: ['about', 'services', 'gallery', 'why', 'hours', 'contact'],
    colors: { bg: '#fbf8f3', surface: '#ffffff', ink: '#2b2118', muted: '#6f6255', accent: '#8a5a2b', accentInk: '#ffffff', band: '#f1e8dc' },
    dark: { bg: '#17130f', surface: '#211b15', ink: '#f3ece3', muted: '#b7a998', accent: '#d9a066', accentInk: '#1b140d', band: '#2a221a' }
  },
  clinic: {
    label: 'Clinic / pharmacy',
    font: 'sans',
    hero: 'split',
    order: ['services', 'hours', 'about', 'why', 'contact'],
    colors: { bg: '#f6fafb', surface: '#ffffff', ink: '#0f2a33', muted: '#4f6a73', accent: '#0e7c86', accentInk: '#ffffff', band: '#e3f1f3' },
    dark: { bg: '#0c1a1e', surface: '#122429', ink: '#e4f2f4', muted: '#9bb7bd', accent: '#4cc3cc', accentInk: '#06201f', band: '#15292e' }
  },
  professional: {
    label: 'Professional services (law, accounting, real estate)',
    font: 'serif',
    hero: 'center',
    order: ['about', 'services', 'why', 'contact', 'hours'],
    colors: { bg: '#f7f7f5', surface: '#ffffff', ink: '#1a1d24', muted: '#5b606b', accent: '#1f3a5f', accentInk: '#ffffff', band: '#e9ebef' },
    dark: { bg: '#111318', surface: '#191c23', ink: '#eceef2', muted: '#a3a9b5', accent: '#8fb0dc', accentInk: '#0e1624', band: '#1d2129' }
  },
  school: {
    label: 'School / training',
    font: 'sans',
    hero: 'split',
    order: ['about', 'services', 'why', 'gallery', 'hours', 'contact'],
    colors: { bg: '#fafaf6', surface: '#ffffff', ink: '#1d2a1c', muted: '#5a6658', accent: '#2f6b2a', accentInk: '#ffffff', band: '#e8f0e3' },
    dark: { bg: '#121710', surface: '#1a2118', ink: '#e9f0e6', muted: '#a7b5a3', accent: '#8fcf83', accentInk: '#10200e', band: '#1d261b' }
  },
  retail: {
    label: 'Shop / salon',
    font: 'sans',
    hero: 'banner',
    order: ['services', 'gallery', 'why', 'hours', 'contact', 'about'],
    colors: { bg: '#fdf9fb', surface: '#ffffff', ink: '#2a1a24', muted: '#6d5864', accent: '#a3326f', accentInk: '#ffffff', band: '#f6e6ef' },
    dark: { bg: '#1a1117', surface: '#231820', ink: '#f6e9f0', muted: '#c3a8b7', accent: '#ec8cbf', accentInk: '#2a0d1c', band: '#2a1d26' }
  },
  tours: {
    label: 'Tour operator',
    font: 'sans',
    hero: 'banner',
    order: ['services', 'about', 'gallery', 'why', 'contact', 'hours'],
    colors: { bg: '#f8faf5', surface: '#ffffff', ink: '#1b2616', muted: '#56644f', accent: '#3d6b1f', accentInk: '#ffffff', band: '#e6eedd' },
    dark: { bg: '#11160d', surface: '#192014', ink: '#ebf2e4', muted: '#a8b89c', accent: '#a5d67a', accentInk: '#14220a', band: '#1c2517' }
  },
  construction: {
    label: 'Construction / garage',
    font: 'sans',
    hero: 'split',
    order: ['services', 'why', 'gallery', 'about', 'contact', 'hours'],
    colors: { bg: '#f7f6f3', surface: '#ffffff', ink: '#22201c', muted: '#625d55', accent: '#c25e00', accentInk: '#ffffff', band: '#efe9e0' },
    dark: { bg: '#15130f', surface: '#1e1b16', ink: '#f1ece4', muted: '#b3aa9c', accent: '#ff9b3d', accentInk: '#2a1500', band: '#262119' }
  },
  generic: {
    label: 'Generic',
    font: 'sans',
    hero: 'center',
    order: ['about', 'services', 'why', 'gallery', 'hours', 'contact'],
    colors: { bg: '#f7f8fa', surface: '#ffffff', ink: '#1a1f2b', muted: '#5a6275', accent: '#2d5be3', accentInk: '#ffffff', band: '#e8ecf6' },
    dark: { bg: '#10131a', surface: '#171b24', ink: '#e8ebf2', muted: '#a0a8ba', accent: '#8aa6ff', accentInk: '#0b1433', band: '#1b2030' }
  }
};

function theme(key) {
  return THEMES[key] || THEMES.generic;
}

module.exports = { THEMES, theme };

'use strict';
// Vercel function: /api/*, /preview/* and /sites/* are rewritten here (see vercel.json).
const { app } = require('../src/app');

module.exports = app;

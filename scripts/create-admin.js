'use strict';
// Usage: npm run create-admin -- <username>
// Prompts for the password (hidden). Resets the password if the user already exists.
const readline = require('node:readline');
const { db } = require('../src/core/db');
const { hashSecret } = require('../src/core/auth');

const username = (process.argv[2] || '').trim();
if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
  console.error('Usage: npm run create-admin -- <username>   (3-40 letters, digits, _ . -)');
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

(async () => {
  const pass = process.env.ADMIN_PASSWORD || await askHidden('Password (min 10 characters): ');
  if (pass.length < 10) {
    console.error('Password must be at least 10 characters.');
    process.exit(1);
  }
  const hash = await hashSecret(pass);
  const existing = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE admins SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hash, existing.id);
    console.log(`Password reset for "${username}".`);
  } else {
    db.prepare('INSERT INTO admins (username, pass_hash) VALUES (?, ?)').run(username, hash);
    console.log(`Admin "${username}" created.`);
  }
})();

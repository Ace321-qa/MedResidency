/**
 * Hypothesis discrimination: does the ER_ACCESS_DENIED_ERROR message
 * distinguish "wrong password" from "no grant for this host" from "no such user"?
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

const HOST = '153.92.15.23';
const PORT = 3306;
const DB = process.env.DB_NAME;
const REAL_USER = process.env.DB_USER;
const REAL_PASS = process.env.DB_PASS;

async function probe(user, pass, database) {
  try {
    const c = await mysql.createConnection({ host: HOST, port: PORT, user, password: pass, database, connectTimeout: 10000 });
    const [r] = await c.query('SELECT CURRENT_USER() AS auth_as');
    await c.end();
    return { ok: true, auth_as: r[0].auth_as };
  } catch (e) {
    return { ok: false, code: e.code, errno: e.errno, sqlState: e.sqlState, message: e.message };
  }
}

(async () => {
  const cases = [
    ['A', 'real user + real password',              REAL_USER, REAL_PASS, DB],
    ['B', 'real user + WRONG password',             REAL_USER, 'definitely_not_the_pass', DB],
    ['C', 'real user + EMPTY password',             REAL_USER, '', DB],
    ['D', 'NONEXISTENT user + any password',        'u531054669_totallyFake', 'whatever123', DB],
    ['E', 'NONEXISTENT user + real password',       'u531054669_totallyFake', REAL_PASS, DB],
    ['F', 'real user + real pass + no database',    REAL_USER, REAL_PASS, undefined],
    ['G', 'real user (no prefix, adminMR)',         'adminMR', REAL_PASS, DB],
  ];

  const out = [];
  for (const [id, label, u, p, d] of cases) {
    const cfg = { host: HOST, port: PORT, user: u, password: p, connectTimeout: 10000 };
    if (d) cfg.database = d;
    let r;
    try {
      const c = await mysql.createConnection(cfg);
      const [rows] = await c.query('SELECT CURRENT_USER() AS auth_as');
      await c.end();
      r = { ok: true, auth_as: rows[0].auth_as };
    } catch (e) {
      r = { ok: false, code: e.code, errno: e.errno, sqlState: e.sqlState, message: e.message };
    }
    out.push([id, label, r]);
    console.log(`${id}  ${label}`);
    if (r.ok) console.log(`    OK   authenticated as ${r.auth_as}`);
    else console.log(`    ${r.code} / ${r.errno} / ${r.sqlState}\n    "${r.message}"`);
  }

  console.log('\n--- message fingerprint comparison (strip the echoed user@host) ---');
  const norm = (m) => m.replace(/'[^']*'@'[^']*'/, "'<USER>@<HOST>'");
  const seen = new Map();
  for (const [id, label, r] of out) {
    if (r.ok) continue;
    const k = `${r.code}|${r.errno}|${r.sqlState}|${norm(r.message)}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(`${id}: ${label}`);
  }
  for (const [k, ids] of seen) {
    console.log(`\n  fingerprint: ${k}`);
    console.log(`  shared by  : ${ids.join(' | ')}`);
  }
  console.log(`\n  distinct failure fingerprints: ${seen.size}`);
  if (seen.size === 1 && out.filter(([, , r]) => !r.ok).length > 1) {
    console.log('\n  CONCLUSION: every distinct cause produces a BYTE-IDENTICAL error.');
    console.log('  The error message therefore carries ZERO information about which');
    console.log('  cause is in play (bad password vs. missing host grant vs. missing user).');
  }
})();
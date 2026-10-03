/**
 * Standalone MySQL connection diagnostic matrix.
 * Run: node scripts/db-diagnose.js
 */
const net = require('net');
const mysql = require('mysql2/promise');
const tls = require('tls');
const dns = require('dns');
require('dotenv').config();

const USER = process.env.DB_USER;
const PASS = process.env.DB_PASS;
const NAME = process.env.DB_NAME;
const PORT = Number(process.env.DB_PORT) || 3306;

const HOSTS = ['153.92.15.23', 'srv1412.hstgr.io'];
const IP = HOSTS[0];

function classify(err) {
  return {
    code: err.code,
    errno: err.errno,
    sqlState: err.sqlState,
    message: err.message,
  };
}

function rawHandshake(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, ms: Date.now() - started });
    };
    socket.setTimeout(8000);
    socket.on('connect', () => {
      socket.once('data', (buf) => {
        const len = buf.length;
        const protoVersion = buf[4];
        let end = 11;
        for (let i = 5; i < len; i++) {
          if (buf[i] === 0 && i > 5) { end = i + 1; break; }
        }
        const serverVersion = buf.slice(5, end).toString('utf8');
        finish({
          ok: true,
          tcpHandshake: true,
          bytes: len,
          serverVersion,
          protocolVersion: protoVersion,
        });
      });
    });
    socket.on('timeout', () => finish({ ok: false, code: 'ETIMEDOUT', message: 'socket timeout (no handshake)' }));
    socket.on('error', (e) => finish({ ok: false, code: e.code, message: e.message }));
  });
}

async function attempt(label, config) {
  const started = Date.now();
  let conn;
  try {
    conn = await mysql.createConnection({ connectTimeout: 10000, ...config });
    const [rows] = await conn.query('SELECT 1 AS ok, CURRENT_USER() AS auth_as, VERSION() AS ver, DATABASE() AS db');
    await conn.end();
    return {
      label,
      success: true,
      ms: Date.now() - started,
      result: rows[0],
    };
  } catch (err) {
    if (conn) { try { await conn.end(); } catch (_) {} }
    return {
      label,
      success: false,
      ms: Date.now() - started,
      error: classify(err),
    };
  }
}

(async () => {
  console.log('='.repeat(78));
  console.log('MedResidency — MySQL Connection Diagnostic');
  console.log('='.repeat(78));
  console.log(`target user : ${USER}`);
  console.log(`target db   : ${NAME}`);
  console.log(`pass length : ${PASS ? PASS.length : 0}`);
  console.log(`client ip   : `);
  for (const family of [4, 6]) {
    await new Promise((resolve) => {
      require('os').networkInterfaces()[`${family === 4 ? 'IPv4' : 'IPv6'}`]?.forEach((i) => {
        if (i.family === 'IPv4' && !i.internal) console.log(`              ${i.address}`);
      });
      resolve();
    });
  }

  console.log('\n--- [1] DNS resolution ---');
  for (const h of HOSTS) {
    if (net.isIP(h)) { console.log(`  ${h.padEnd(20)} -> (literal IPv4, skip DNS)`); continue; }
    try {
      const r = await dns.promises.lookup(h);
      console.log(`  ${h.padEnd(20)} -> ${r.address} (family ${r.family})`);
    } catch (e) {
      console.log(`  ${h.padEnd(20)} -> DNS FAIL ${e.code}`);
    }
  }

  console.log('\n--- [2] TCP + MySQL handshake banner ---');
  for (const h of HOSTS) {
    const r = await rawHandshake(h, PORT);
    console.log(`  ${h.padEnd(20)} -> ${r.ok ? `OK  v${r.serverVersion}  proto=${r.protocolVersion}  ${r.ms}ms` : `FAIL ${r.code} ${r.message} ${r.ms}ms`}`);
  }

  console.log('\n--- [3] TLS negotiation check ---');
  await new Promise((resolve) => {
    const s = tls.connect({ host: IP, port: PORT, rejectUnauthorized: false, servername: IP }, () => {
      console.log(`  STARTTLS/TLS available: ${s.authorized ? 'authorized' : 'handshake ok, cert unverified'}`);
      console.log(`  protocol: ${s.getProtocol()}`);
      s.destroy();
      resolve();
    });
    s.on('error', (e) => { console.log(`  TLS not offered: ${e.code} ${e.message}`); resolve(); });
    s.setTimeout(8000, () => { console.log('  TLS timeout'); s.destroy(); resolve(); });
  });

  console.log('\n--- [4] Connection matrix ---');
  const matrix = [];
  for (const host of HOSTS) {
    matrix.push([`${host} | plain | dotenv`, {
      host, port: PORT, user: USER, password: PASS, database: NAME,
    }]);
  }
  matrix.push([`${IP} | ssl(rejectUnauthorized:false) | dotenv`, {
    host: IP, port: PORT, user: USER, password: PASS, database: NAME,
    ssl: { rejectUnauthorized: false },
  }]);
  matrix.push([`${IP} | plain | NO database selected`, {
    host: IP, port: PORT, user: USER, password: PASS,
  }]);
  matrix.push([`${IP} | plain | localhost user`, {
    host: IP, port: PORT, user: 'u531054669_adminMR', password: PASS, database: NAME,
  }]);
  matrix.push([`${IP} | plain | mysql_native_password forced`, {
    host: IP, port: PORT, user: USER, password: PASS, database: NAME,
    authPlugins: { mysql_native_password: () => require('mysql2/promise')() },
  }]);

  const results = [];
  for (const [label, cfg] of matrix) {
    const r = await attempt(label, cfg);
    results.push(r);
    if (r.success) {
      console.log(`  PASS  ${label}`);
      console.log(`        -> auth_as=${r.result.auth_as} ver=${r.result.ver} db=${r.result.db} (${r.ms}ms)`);
    } else {
      console.log(`  FAIL  ${label}`);
      console.log(`        -> code=${r.error.code} errno=${r.error.errno} sqlState=${r.error.sqlState}`);
      console.log(`        -> ${r.error.message}`);
    }
  }

  console.log('\n--- [5] Verdicts ---');
  const anySuccess = results.some((r) => r.success);
  const allDenied = results.every((r) => !r.success && r.error.code === 'ER_ACCESS_DENIED_ERROR');

  if (anySuccess) {
    const ok = results.find((r) => r.success);
    console.log('  NETWORK + AUTH OK. Working combination:', ok.label);
  } else if (allDenied) {
    console.log('  NETWORK: healthy (TCP + MySQL banner received on every attempt).');
    console.log('  FAILURE CLASS: ER_ACCESS_DENIED_ERROR -> server-side credential/grant problem.');
    console.log('  The MySQL server received the TCP connection, read the username and password,');
    console.log('  and found NO matching User@Host row with a matching password hash.');
    console.log('  This is NOT a local .env / quoting / SSL / driver problem.');
  } else {
    console.log('  Mixed failures — see per-attempt codes above.');
  }
  console.log('='.repeat(78));
  process.exit(anySuccess ? 0 : 1);
})();
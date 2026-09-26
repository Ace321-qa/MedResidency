const mysql = require("mysql2/promise");

const REQUIRED = ["DB_NAME", "DB_USER", "DB_PASSWORD"];

function missingVariables() {
  return REQUIRED.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === "";
  });
}

/**
 * Safe, non-secret description of the target database.
 * Intended for server-side logging only. Never returns credentials.
 */
function describeTarget() {
  return {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || null,
    user: process.env.DB_USER || null,
    passwordPresent: Boolean(process.env.DB_PASSWORD),
  };
}

/**
 * The pool is created lazily: no TCP connection is opened until the first
 * query, so a database outage cannot stop the HTTP server from booting.
 */
const pool = mysql.createPool({
  // 127.0.0.1 (not "localhost") is deliberate. On Node.js 17+ the system
  // resolver commonly returns ::1 before 127.0.0.1 for "localhost", and
  // shared-hosting MySQL accounts are granted on 127.0.0.1, not ::1.
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  enableKeepAlive: true,
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT || 10000),
  multipleStatements: false,
});

async function query(sql, params) {
  return pool.query(sql, params);
}

async function ping() {
  await pool.query("SELECT 1");
  return true;
}

module.exports = { pool, query, ping, describeTarget, missingVariables };

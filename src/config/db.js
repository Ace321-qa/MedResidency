const mysql = require('mysql2/promise');
require('dotenv').config();

// Create a connection pool to Hostinger MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'u531054669_MedResidency',
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Helper function to test database connectivity
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Successfully connected to Hostinger MySQL Database:', process.env.DB_NAME);
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

// Variables without a value the app cannot function against Hostinger MySQL
const REQUIRED_VARS = ['DB_NAME', 'DB_USER'];

// Reports which database variables are absent, so the server can warn on boot
// instead of failing later on the first query.
function missingVariables() {
  return REQUIRED_VARS.filter((name) => {
    const value = process.env[name];
    return value === undefined || value === '';
  });
}

// Export the promise pool directly so consumers can call:
//   const db = require('../config/db');
//   await db.query(sql, params);
//   const conn = await db.getConnection();
// NOTE: do NOT attach a `pool` alias here — mysql2's PromisePool already uses
// `pool` internally for its core pool reference, so assigning it would cause
// infinite recursion (RangeError: Maximum call stack size exceeded).
pool.testConnection = testConnection;
pool.missingVariables = missingVariables;

module.exports = pool;

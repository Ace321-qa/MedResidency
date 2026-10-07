const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./config/db');
const { testConnection } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
const residentRoutes = require('./routes/residentRoutes');

// Root Route
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to MedResidency Core API',
    version: '1.0.0',
    documentation: '/api/v1/health',
  });
});
// Import the rotation routes

const rotationRoutes = require('./routes/rotationRoutes');

// Mount under /api/v1/rotations
app.use('/api/v1/rotations', rotationRoutes);

// Import the attendance routes
const attendanceRoutes = require('./routes/attendanceRoutes');

// Mount under /api/v1/attendance
app.use('/api/v1/attendance', attendanceRoutes);

// API Routes
app.use('/api/v1/residents', residentRoutes);

// Import the leave request routes
const leaveRoutes = require('./routes/leaveRoutes');

// Mount under /api/v1/leaves
app.use('/api/v1/leaves', leaveRoutes);

// Import the release letter routes
const releaseLetterRoutes = require('./routes/releaseLetterRoutes');

// Mount under /api/v1/letters
app.use('/api/v1/letters', releaseLetterRoutes);

// Checkpoint 16 / 17 Health Check Endpoint
app.get('/api/v1/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS is_alive, NOW() AS db_time, DATABASE() AS database_name');
    res.status(200).json({
      status: 'success',
      server: 'MedResidency Backend API',
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        database_name: rows[0].database_name,
        database_time: rows[0].db_time,
      },
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      message: 'Database connection failed',
      error: error.message,
    });
  }
});

// Start Server
if (require.main === module) {
  const server = app.listen(PORT, async () => {
    console.log(`🚀 MedResidency API server running on http://localhost:${PORT}`);

    const missing = require('./config/db').missingVariables();
    if (missing.length > 0) {
      console.error(
        `[config] MISSING environment variables: ${missing.join(', ')}. ` +
          'Set them in the Hostinger Web App environment variables.'
      );
    }

    await testConnection();
  });

  server.on('error', (error) => {
    console.error('[server] fatal error:', error.message);
    process.exit(1);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`[server] ${signal} received, draining in-flight requests...`);
      server.close(async () => {
        await pool.end().catch(() => {});
        process.exit(0);
      });
    });
  }
}

module.exports = app;

// Longitudinal routes
const longitudinalRoutes = require('./routes/longitudinalRoutes');
app.use('/api/v1/longitudinal', longitudinalRoutes);

const rosterImportRoutes = require('./routes/rosterImportRoutes');
const letterTemplateRoutes = require('./routes/letterTemplateRoutes');
const rotationImportRoutes = require('./routes/rotationImportRoutes');
const rotationRequestRoutes = require('./routes/rotationRequestRoutes');

app.use('/api/v1/roster', rosterImportRoutes);
app.use('/api/v1/letters/templates', letterTemplateRoutes);
app.use('/api/v1/rotations/import', rotationImportRoutes);
app.use('/api/v1/requests/rotation', rotationRequestRoutes);

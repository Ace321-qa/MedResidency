const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./config/db');
const { testConnection } = require('./config/db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
// Schedule exports post a full grid (up to 52 week columns × every resident),
// which comfortably exceeds Express's 100kb default, so the JSON limit is
// raised here rather than shrinking the report.
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));

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

// Rotation catalogue management (list, create, edit, delete, template, import).
// Mounted after the rotation routes above: nothing there matches a bare
// `/catalogue` path, so the request falls through to this router.
const rotationCatalogueRoutes = require('./routes/rotationCatalogueRoutes');

app.use('/api/v1/rotations/catalogue', rotationCatalogueRoutes);

// Import the attendance routes
const attendanceRoutes = require('./routes/attendanceRoutes');

// Mount under /api/v1/attendance
app.use('/api/v1/attendance', attendanceRoutes);

// API Routes
app.use('/api/v1/residents', residentRoutes);

// Programme registry — create, rename, deactivate and delete residency
// programmes. Read by the sign-in picker and the coordinator settings screen.
const programRoutes = require('./routes/programRoutes');

app.use('/api/v1/programs', programRoutes);

// Import the leave request routes
const leaveRoutes = require('./routes/leaveRoutes');

// Mount under /api/v1/leaves
app.use('/api/v1/leaves', leaveRoutes);

// Notifications (resident bell / system event feed)
const notificationRoutes = require('./routes/notificationRoutes');

// Mount under /api/v1/notifications
app.use('/api/v1/notifications', notificationRoutes);

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

    // Bring the notifications schema up (users scaffold + notifications table)
    // so the first system event has somewhere to land. Idempotent DDL.
    try {
      const NotificationService = require('./services/notificationService');
      await NotificationService.ensureSchema();
      console.log('[notifications] schema ready.');
    } catch (error) {
      console.error('[notifications] could not ensure schema:', error.message);
    }

    // Bring the release-letter engine's schema up (subject column rename,
    // rotation anchor, sent_status lifecycle) and seed the default
    // STANDARD-RELEASE template for every programme. Idempotent DDL.
    try {
      const ReleaseLetterService = require('./services/releaseLetterService');
      await ReleaseLetterService.ensureReady();
      console.log('[release-letters] schema and default templates ready.');
    } catch (error) {
      console.error('[release-letters] could not ensure schema:', error.message);
    }

    // Seed the standard Continuity of Care Clinics (CCC) for every programme so a fresh
    // install (or a programme created after the last boot) starts with its five
    // default clinics. Idempotent: existing rows are matched by name.
    try {
      const LongitudinalService = require('./services/longitudinalService');
      // Bring the CCC schema up to date first: `display_order` and the absence
      // registry must exist before the default clinics are seeded.
      await LongitudinalService.ensureSchema();
      const seeded = await LongitudinalService.ensureDefaultClinics();
      console.log(`[primary-care] ensured ${seeded.length} default clinic record(s).`);
    } catch (error) {
      console.error('[primary-care] could not seed default clinics:', error.message);
    }
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
const rotationImportRoutes = require('./routes/rotationImportRoutes');
const rotationRequestRoutes = require('./routes/rotationRequestRoutes');

app.use('/api/v1/roster', rosterImportRoutes);
app.use('/api/v1/rotations/import', rotationImportRoutes);
app.use('/api/v1/requests/rotation', rotationRequestRoutes);

// Schedule exports (styled .xlsx from the shared report model).
const exportRoutes = require('./routes/exportRoutes');
app.use('/api/v1/exports', exportRoutes);

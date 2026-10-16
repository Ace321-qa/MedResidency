#!/usr/bin/env node

/**
 * Create the `users` scaffold and `notifications` tables.
 *
 * This repository has no migration runner; schema is normally brought up by
 * `ensureSchema()` on boot (see `NotificationService`). This script exposes the
 * same DDL as an explicit, runnable step for a fresh environment.
 *
 *   npm run db:notifications
 */

const NotificationService = require('../src/services/notificationService');
const db = require('../src/config/db');

async function main() {
  try {
    await NotificationService.ensureSchema();
    console.log('✓ users and notifications schema are ready.');
  } catch (error) {
    console.error('✗ could not create notifications schema:', error.message);
    process.exitCode = 1;
  } finally {
    await db.end().catch(() => {});
  }
}

main();

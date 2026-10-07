#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Dev/demo seed only. In fresh production, DB must be clean.
console.log('Seed script (dev/demo only). No destructive operations by default.');

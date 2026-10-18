'use strict';
const db = require('./db');
const { migrate } = require('./schema');
(async () => {
  await db.init();
  await migrate();
  console.log('Database schema is up to date.');
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });

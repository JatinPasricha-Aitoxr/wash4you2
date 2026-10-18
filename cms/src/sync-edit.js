'use strict';
require('./editsite').refresh().then((s) => console.log('Editor site ready:', s)).catch((e) => { console.error(e.message); process.exit(1); });

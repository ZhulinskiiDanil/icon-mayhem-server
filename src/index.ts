import { createApp } from './app.js';
import { config } from './config.js';
import { initDb } from './db.js';

if (config.authDev) console.warn('AUTH_DEV is on: logins are NOT checked. Never use it on the real server');

await initDb();
createApp().listen(config.port, () => {
  console.log(`Icon Mayhem gallery on port ${config.port}`);
});

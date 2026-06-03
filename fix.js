const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
p.query("ALTER TABLE trips ADD COLUMN IF NOT EXISTS platformcommission REAL DEFAULT 0")
  .then(r => { console.log('Added platformcommission column:', r.rowCount); p.end(); })
  .catch(e => { console.error(e.message); p.end(); });

const { Pool } = require('pg');

let pool;

function getPool() {
    if (!pool) {
        const connStr = process.env.DATABASE_URL;
        if (connStr) {
            pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
            console.log('Connected to PostgreSQL (Neon)');
        } else {
            throw new Error('DATABASE_URL no configurada');
        }
    }
    return pool;
}

async function dbRun(sql, args = []) {
    const p = getPool();
    const result = await p.query(sql, args);
    return result;
}

async function dbGet(sql, args = []) {
    const p = getPool();
    const result = await p.query(sql, args);
    return result.rows[0] || null;
}

async function dbAll(sql, args = []) {
    const p = getPool();
    const result = await p.query(sql, args);
    return result.rows;
}

async function dbExec(sql) {
    const p = getPool();
    await p.query(sql);
}

module.exports = { dbRun, dbGet, dbAll, dbExec, getPool };
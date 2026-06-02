const { Pool } = require('pg');

let pool;

function getPool() {
    if (!pool) {
        let connStr = process.env.DATABASE_URL;
        if (connStr) {
            connStr = connStr.replace(/&channel_binding=\w+/g, '');
            pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
            pool.on('error', (err) => { console.error('DB pool error:', err.message); });
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

async function dbClientExec(sql) {
    const p = getPool();
    const client = await p.connect();
    try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

module.exports = { dbRun, dbGet, dbAll, dbExec, dbClientExec, getPool };
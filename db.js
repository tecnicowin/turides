const { createClient } = require('@libsql/client');

let client;

function getClient() {
    if (!client) {
        const url = process.env.TURSO_DATABASE_URL;
        const authToken = process.env.TURSO_AUTH_TOKEN;
        if (url) {
            client = createClient({ url, authToken: authToken || undefined });
            console.log('Connected to Turso cloud database');
        } else {
            client = createClient({ url: 'file:turides.db' });
            console.log('Using local SQLite file (data will NOT persist on Render free tier)');
        }
    }
    return client;
}

async function dbRun(sql, args = []) {
    const c = getClient();
    const result = await c.execute({ sql, args });
    return result;
}

async function dbGet(sql, args = []) {
    const c = getClient();
    const result = await c.execute({ sql, args });
    return result.rows[0] || null;
}

async function dbAll(sql, args = []) {
    const c = getClient();
    const result = await c.execute({ sql, args });
    return result.rows;
}

async function dbExec(sql) {
    const c = getClient();
    await c.execute(sql);
}

module.exports = { dbRun, dbGet, dbAll, dbExec, getClient };

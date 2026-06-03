const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { dbRun, dbGet, dbAll, dbExec, dbClientExec } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json());
app.use(express.static(__dirname));

const SEED_CONFIG = {
    bankName: 'Banco de Venezuela',
    accountNumber: '0102-0000-0000-0000-0000',
    accountType: 'Ahorro',
    documentType: 'V',
    documentNumber: '00000000',
    phone: '0412-0000000',
    holderName: 'TuRides C.A.',
    bcvRate: '36.50',
    bcvLastUpdate: new Date().toISOString(),
    withdrawalCommission: '10'
};

const USER_MAP = {
    tariffmode: 'tariffMode', fixedtariffs: 'fixedTariffs', bankinfo: 'bankInfo',
    twofactorenabled: 'twoFactorEnabled', twofactorsecret: 'twoFactorSecret',
    passwordchanged: 'passwordChanged'
};
const TRIP_MAP = {
    clientid: 'clientId', clientname: 'clientName', clientphone: 'clientPhone',
    originaddress: 'originAddress', destinationaddress: 'destinationAddress',
    conductorid: 'conductorId', conductorname: 'conductorName',
    conductorphone: 'conductorPhone', conductorvehicle: 'conductorVehicle',
    pricebs: 'priceBs', paymentmethod: 'paymentMethod', paymentstatus: 'paymentStatus',
    clientrating: 'clientRating', conductorrating: 'conductorRating',
    clientratingat: 'clientRatingAt', conductorratingat: 'conductorRatingAt',
    createdat: 'createdAt', completedat: 'completedAt',
    paymentverifiedat: 'paymentVerifiedAt', faremultiplier: 'fareMultiplier',
    fareperiod: 'farePeriod'
};
const TXN_MAP = { tripid: 'tripId', clientid: 'clientId', conductorid: 'conductorId', amountbs: 'amountBs', bankcode: 'bankCode', createdat: 'createdAt' };
const RECHARGE_MAP = { userid: 'userId', username: 'userName', amountbs: 'amountBs', bankcode: 'bankCode', adminnote: 'adminNote', createdat: 'createdAt', reviewedat: 'reviewedAt' };
const WITHDRAWAL_MAP = { conductorid: 'conductorId', conductorname: 'conductorName', amountbs: 'amountBs', netamount: 'netAmount', bankinfo: 'bankInfo', adminnote: 'adminNote', createdat: 'createdAt', reviewedat: 'reviewedAt' };

function mapRow(row, m) {
    if (!row) return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) { out[m[k] || k] = v; }
    return out;
}

async function initDB() {
    const { getPool } = require('./db');
    const pool = getPool();
    const client = await pool.connect();
    try {
        for (const t of ['withdrawals', 'recharges', 'transactions', 'trips', 'users', 'config']) {
            await client.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
        }
        await client.query(`CREATE TABLE users (
            id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT UNIQUE, password TEXT,
            role TEXT, available INTEGER DEFAULT 0, vehicle TEXT, tariffmode TEXT,
            fixedtariffs TEXT, balance REAL DEFAULT 0, bankinfo TEXT, ratings TEXT DEFAULT '[]',
            twofactorsecret TEXT, twofactorenabled INTEGER DEFAULT 0, passwordchanged INTEGER DEFAULT 0
        )`);
        await client.query(`CREATE TABLE trips (
            id TEXT PRIMARY KEY, clientid TEXT, clientname TEXT, clientphone TEXT,
            originaddress TEXT, destinationaddress TEXT, distance REAL,
            conductorid TEXT, conductorname TEXT, conductorphone TEXT, conductorvehicle TEXT,
            price REAL, pricebs REAL, paymentmethod TEXT, status TEXT DEFAULT 'pendiente',
            paymentstatus TEXT, clientrating INTEGER, conductorrating INTEGER,
            clientratingat TEXT, conductorratingat TEXT, createdat TEXT, completedat TEXT,
            paymentverifiedat TEXT, faremultiplier REAL DEFAULT 1.0, fareperiod TEXT DEFAULT 'normal'
        )`);
        await client.query(`CREATE TABLE transactions (
            id TEXT PRIMARY KEY, tripid TEXT, clientid TEXT, conductorid TEXT,
            amount REAL, amountbs REAL, method TEXT, status TEXT,
            reference TEXT, phone TEXT, bankcode TEXT, createdat TEXT
        )`);
        await client.query(`CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT)`);
        await client.query(`CREATE TABLE recharges (
            id TEXT PRIMARY KEY, userid TEXT, username TEXT, amount REAL, amountbs REAL,
            phone TEXT, bankcode TEXT, reference TEXT, status TEXT DEFAULT 'pendiente',
            adminnote TEXT, createdat TEXT, reviewedat TEXT
        )`);
        await client.query(`CREATE TABLE withdrawals (
            id TEXT PRIMARY KEY, conductorid TEXT, conductorname TEXT,
            amount REAL, amountbs REAL, commission REAL DEFAULT 0, netamount REAL DEFAULT 0,
            bankinfo TEXT, status TEXT DEFAULT 'pendiente', adminnote TEXT,
            reference TEXT, createdat TEXT, reviewedat TEXT
        )`);

        const existingConfig = await client.query('SELECT key FROM config LIMIT 1');
        if (existingConfig.rows.length === 0) {
            for (const [k, v] of Object.entries(SEED_CONFIG)) {
                await client.query('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
            }
        }

        const userCount = await client.query('SELECT COUNT(*)::int as c FROM users');
        console.log(`Database ready. Users: ${userCount.rows[0].c}`);
    } finally {
        client.release();
    }
}

function parseUser(row) {
    if (!row) return null;
    const m = mapRow(row, USER_MAP);
    const { password, twofactorsecret, ...safe } = m;
    safe.available = !!safe.available;
    safe.twoFactorEnabled = !!safe.twoFactorEnabled;
    safe.passwordChanged = !!safe.passwordChanged;
    if (safe.vehicle) { try { safe.vehicle = typeof safe.vehicle === 'string' ? JSON.parse(safe.vehicle) : safe.vehicle; } catch(e) { safe.vehicle = null; } }
    if (safe.fixedTariffs) { try { safe.fixedTariffs = typeof safe.fixedTariffs === 'string' ? JSON.parse(safe.fixedTariffs) : safe.fixedTariffs; } catch(e) { safe.fixedTariffs = {}; } }
    if (safe.ratings) { try { safe.ratings = typeof safe.ratings === 'string' ? JSON.parse(safe.ratings || '[]') : (safe.ratings || []); } catch(e) { safe.ratings = []; } }
    if (safe.bankInfo) { try { safe.bankInfo = typeof safe.bankInfo === 'string' ? JSON.parse(safe.bankInfo || '{}') : (safe.bankInfo || {}); } catch(e) { safe.bankInfo = {}; } }
    return safe;
}

function parseTrip(row) {
    if (!row) return null;
    const m = mapRow(row, TRIP_MAP);
    m.clientRating = m.clientRating || null;
    m.conductorRating = m.conductorRating || null;
    m.fareMultiplier = m.fareMultiplier || 1.0;
    m.farePeriod = m.farePeriod || 'normal';
    return m;
}

async function getConfig() {
    const rows = await dbAll('SELECT * FROM config');
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    return config;
}

async function getBCVRate() {
    const config = await getConfig();
    return parseFloat(config.bcvRate) || 36.50;
}

async function toBs(usd) {
    const rate = await getBCVRate();
    return parseFloat((usd * rate).toFixed(2));
}

function getFarePeriod() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeVal = hour + minute / 60;
    if (timeVal >= 17 && timeVal < 20) return { period: 'pico', multiplier: 1.25 };
    if (timeVal >= 22 || timeVal < 5) return { period: 'noche', multiplier: 1.20 };
    return { period: 'normal', multiplier: 1.0 };
}

const KILOMETER_RATE = {
    carro: { base: 1.80, perKm: 0.50, minDistance: 2.5 },
    moto: { base: 0.80, perKm: 0.20, minDistance: 2.5 }
};

// === AUTH ===
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE email = $1 AND password = $2', [email.toLowerCase(), password]);
    if (!row) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const m = mapRow(row, USER_MAP);
    if (m.twoFactorEnabled) return res.json({ twoFactorRequired: true, userId: m.id });
    res.json(parseUser(row));
});

app.post('/api/login/2fa-verify', async (req, res) => {
    const { userId, code } = req.body;
    const OTPAuth = require('otpauth');
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [userId]);
    if (!row) return res.status(401).json({ error: 'Usuario no encontrado' });
    const m = mapRow(row, USER_MAP);
    if (!m.twoFactorEnabled || !m.twoFactorSecret) return res.status(400).json({ error: '2FA no activo' });
    const totp = new OTPAuth.TOTP({ issuer: 'TuRides', label: m.email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(m.twoFactorSecret) });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) return res.status(401).json({ error: 'Codigo 2FA incorrecto' });
    res.json(parseUser(row));
});

app.post('/api/register', async (req, res) => {
    const { name, phone, email, password, role, vehicleData } = req.body;
    const exists = await dbGet('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists) return res.status(400).json({ error: 'El correo ya esta registrado' });
    const vehicle = role === 'conductor' && vehicleData ? JSON.stringify({ type: vehicleData.type || 'carro', brand: vehicleData.brand, model: vehicleData.model, passengers: parseInt(vehicleData.passengers) || 4, suitcases: parseInt(vehicleData.suitcases) || 2 }) : null;
    const tariffMode = role === 'conductor' ? (vehicleData?.tariffMode || 'kilometros') : null;
    const fixedTariffs = role === 'conductor' ? JSON.stringify({ defaultPrice: 20.00 }) : null;
    await dbRun('INSERT INTO users (id, name, phone, email, password, role, available, vehicle, tariffmode, fixedtariffs, balance, ratings, bankinfo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12)',
        [email, name, phone, email.toLowerCase(), password, role, 0, vehicle, tariffMode, fixedTariffs, '[]', '{}']);
    const user = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [email]));
    io.emit('user:created', user);
    res.json(user);
});

// === SETUP ===
app.get('/api/setup/status', async (req, res) => {
    const adminCount = await dbGet("SELECT COUNT(*)::int as c FROM users WHERE role = 'admin'");
    const userCount = await dbGet('SELECT COUNT(*)::int as c FROM users');
    res.json({ hasAdmin: adminCount.c > 0, totalUsers: userCount.c });
});

app.post('/api/setup/admin', async (req, res) => {
    const adminCount = await dbGet("SELECT COUNT(*)::int as c FROM users WHERE role = 'admin'");
    if (adminCount.c > 0) return res.status(400).json({ error: 'Ya existe un administrador.' });
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contrasena son requeridos' });
    const id = email.toLowerCase();
    await dbRun('INSERT INTO users (id, name, phone, email, password, role, available, balance, ratings, bankinfo, passwordchanged) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, 1)',
        [id, name, phone || null, email.toLowerCase(), password, 'admin', 0, '[]', '{}']);
    const user = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [id]));
    io.emit('user:created', user);
    res.json(user);
});

app.post('/api/change-password', async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (row.password !== currentPassword) return res.status(401).json({ error: 'Contrasena actual incorrecta' });
    if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: 'Minimo 3 caracteres' });
    await dbRun('UPDATE users SET password = $1, passwordchanged = 1 WHERE id = $2', [newPassword, userId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [userId]));
    io.emit('user:updated', updated);
    res.json({ success: true, message: 'Contrasena actualizada' });
});

// === 2FA ===
app.post('/api/2fa/setup', async (req, res) => {
    const OTPAuth = require('otpauth');
    const QRCode = require('qrcode');
    const { userId } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    const m = mapRow(row, USER_MAP);
    if (m.twoFactorEnabled) return res.status(400).json({ error: '2FA ya activo' });
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: 'TuRides', label: m.email, algorithm: 'SHA1', digits: 6, period: 30, secret });
    await dbRun('UPDATE users SET twofactorsecret = $1 WHERE id = $2', [secret.base32, userId]);
    const otpauthUrl = totp.toString();
    QRCode.toDataURL(otpauthUrl, (err, dataUrl) => {
        if (err) return res.status(500).json({ error: 'Error generando QR' });
        res.json({ secret: secret.base32, qrCode: dataUrl, otpauthUrl });
    });
});

app.post('/api/2fa/verify-and-enable', async (req, res) => {
    const OTPAuth = require('otpauth');
    const { userId, code } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    const m = mapRow(row, USER_MAP);
    if (!m.twoFactorSecret) return res.status(400).json({ error: 'Primero genera un secreto 2FA' });
    const totp = new OTPAuth.TOTP({ issuer: 'TuRides', label: m.email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(m.twoFactorSecret) });
    if (totp.validate({ token: code, window: 1 }) === null) return res.status(400).json({ error: 'Codigo incorrecto' });
    await dbRun('UPDATE users SET twofactorenabled = 1 WHERE id = $1', [userId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [userId]));
    io.emit('user:updated', updated);
    res.json({ success: true, message: '2FA activado' });
});

app.post('/api/2fa/disable', async (req, res) => {
    const { userId, password } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (row.password !== password) return res.status(401).json({ error: 'Contrasena incorrecta' });
    await dbRun('UPDATE users SET twofactorenabled = 0, twofactorsecret = NULL WHERE id = $1', [userId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [userId]));
    io.emit('user:updated', updated);
    res.json({ success: true, message: '2FA desactivado' });
});

app.post('/api/setup/reset', (req, res) => {
    return res.status(403).json({ error: 'Funcion deshabilitada por seguridad.' });
});

// === USERS ===
app.get('/api/users', async (req, res) => {
    const rows = await dbAll('SELECT * FROM users');
    res.json(rows.map(r => parseUser(r)));
});

app.get('/api/users/:id', async (req, res) => {
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(parseUser(row));
});

app.put('/api/users/:id', async (req, res) => {
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    const updates = req.body;
    const keyMap = { vehicle: 'vehicle', fixedTariffs: 'fixedtariffs', ratings: 'ratings', bankInfo: 'bankinfo', available: 'available', tariffMode: 'tariffmode', name: 'name', phone: 'phone', email: 'email' };
    if (updates.vehicle && typeof updates.vehicle === 'object') updates.vehicle = JSON.stringify(updates.vehicle);
    if (updates.fixedTariffs && typeof updates.fixedTariffs === 'object') updates.fixedTariffs = JSON.stringify(updates.fixedTariffs);
    if (updates.ratings && Array.isArray(updates.ratings)) updates.ratings = JSON.stringify(updates.ratings);
    if (updates.bankInfo && typeof updates.bankInfo === 'object') updates.bankInfo = JSON.stringify(updates.bankInfo);
    if (updates.available !== undefined) updates.available = updates.available ? 1 : 0;
    const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'password' && k !== 'twoFactorSecret' && k !== 'twoFactorEnabled' && k !== 'passwordChanged');
    if (fields.length === 0) return res.json(parseUser(row));
    const setParts = fields.map((f, i) => `${keyMap[f] || f} = $${i + 1}`);
    const values = fields.map(f => updates[f]);
    await dbRun(`UPDATE users SET ${setParts.join(', ')} WHERE id = $${fields.length + 1}`, [...values, req.params.id]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [req.params.id]));
    io.emit('user:updated', updated);
    res.json(updated);
});

// === CONDUCTORS ===
app.get('/api/conductors/available', async (req, res) => {
    const distance = parseFloat(req.query.distance) || 10;
    const vehicleType = req.query.vehicleType || 'carro';
    const rows = await dbAll("SELECT * FROM users WHERE role = 'conductor' AND available = 1");
    const fareInfo = getFarePeriod();
    const conductors = rows.filter(c => {
        const v = typeof c.vehicle === 'string' ? JSON.parse(c.vehicle || '{}') : (c.vehicle || {});
        return v.type === vehicleType;
    }).map(c => {
        const cu = parseUser(c);
        const vehicle = cu.vehicle || {};
        const fixedTariffs = cu.fixedTariffs || {};
        const ratings = cu.ratings || [];
        let price = 0;
        const rates = KILOMETER_RATE[vehicle.type] || KILOMETER_RATE.carro;
        if (c.tariffmode === 'fijo') {
            price = parseFloat(fixedTariffs.defaultPrice) || 35.00;
        } else {
            price = rates.base;
            if (distance > rates.minDistance) price += (distance - rates.minDistance) * rates.perKm;
        }
        price = parseFloat((price * fareInfo.multiplier).toFixed(2));
        const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
        return { ...cu, calculatedPrice: price, calculatedPriceBs: price * 36.50, avgRating, ratingCount: ratings.length, farePeriod: fareInfo.period, fareMultiplier: fareInfo.multiplier };
    });
    res.json(conductors);
});

// === TRIPS ===
app.get('/api/trips', async (req, res) => {
    const rows = await dbAll('SELECT * FROM trips ORDER BY createdat DESC');
    res.json(rows.map(r => parseTrip(r)));
});

app.post('/api/trips', async (req, res) => {
    const { clientId, clientName, clientPhone, originAddress, destinationAddress, distance, conductorId, price, paymentMethod } = req.body;
    const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [conductorId]);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    const vehicle = typeof conductor.vehicle === 'string' ? JSON.parse(conductor.vehicle || '{}') : (conductor.vehicle || {});
    const id = 'TRIP_' + Date.now();
    const now = new Date().toISOString();
    const fareInfo = getFarePeriod();
    const finalPrice = parseFloat((price * fareInfo.multiplier).toFixed(2));
    const rate = await getBCVRate();
    const priceBs = parseFloat((finalPrice * rate).toFixed(2));
    await dbRun('INSERT INTO trips (id, clientid, clientname, clientphone, originaddress, destinationaddress, distance, conductorid, conductorname, conductorphone, conductorvehicle, price, pricebs, paymentmethod, status, createdat, faremultiplier, fareperiod) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)',
        [id, clientId, clientName, clientPhone, originAddress, destinationAddress, parseFloat(distance), conductorId, conductor.name, conductor.phone, `${vehicle.brand} ${vehicle.model}`, finalPrice, priceBs, paymentMethod, 'pendiente', now, fareInfo.multiplier, fareInfo.period]);
    const trip = parseTrip(await dbGet('SELECT * FROM trips WHERE id = $1', [id]));
    io.emit('trip:created', trip);
    io.to('conductor_' + conductorId).emit('trip:new_request', trip);
    res.json(trip);
});

app.put('/api/trips/:id/status', async (req, res) => {
    const trip = await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { status } = req.body;
    const now = new Date().toISOString();
    if (status === 'completado') {
        await dbRun('UPDATE trips SET status = $1, completedat = $2 WHERE id = $3', [status, now, req.params.id]);
        if (trip.paymentmethod === 'rkm' && trip.paymentstatus !== 'pagado') {
            const client = await dbGet('SELECT * FROM users WHERE id = $1', [trip.clientid]);
            if (client && client.balance >= trip.price) {
                const newClientBal = parseFloat((client.balance - trip.price).toFixed(2));
                await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newClientBal, trip.clientid]);
                const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]);
                if (conductor) {
                    const newCondBal = parseFloat((conductor.balance + trip.price).toFixed(2));
                    await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newCondBal, trip.conductorid]);
                }
                const rate = await getBCVRate();
                const amountBs = parseFloat((trip.price * rate).toFixed(2));
                await dbRun('INSERT INTO transactions (id, tripid, clientid, conductorid, amount, amountbs, method, status, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                    ['TXN_' + Date.now(), req.params.id, trip.clientid, trip.conductorid, trip.price, amountBs, 'rkm', 'completado', now]);
                await dbRun('UPDATE trips SET paymentstatus = $1 WHERE id = $2', ['pagado', req.params.id]);
                const updatedClient = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.clientid]));
                const updatedConductor = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]));
                io.to('client_' + trip.clientid).emit('user:updated', updatedClient);
                io.to('conductor_' + trip.conductorid).emit('user:updated', updatedConductor);
                io.emit('payment:completed', { tripId: req.params.id, method: 'rkm' });
            }
        }
    } else if (status === 'pago_verificado') {
        await dbRun('UPDATE trips SET status = $1, paymentverifiedat = $2 WHERE id = $3', [status, now, req.params.id]);
    } else if (status === 'aceptado') {
        await dbRun('UPDATE trips SET status = $1 WHERE id = $2', [status, req.params.id]);
        await dbRun('UPDATE users SET available = 0 WHERE id = $1', [trip.conductorid]);
    } else if (status === 'calificado') {
        await dbRun('UPDATE trips SET status = $1 WHERE id = $2', [status, req.params.id]);
        await dbRun('UPDATE users SET available = 1 WHERE id = $1', [trip.conductorid]);
    } else {
        await dbRun('UPDATE trips SET status = $1 WHERE id = $2', [status, req.params.id]);
    }
    const updated = parseTrip(await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.id]));
    io.emit('trip:status_changed', updated);
    io.to('client_' + updated.clientId).emit('trip:status_changed', updated);
    io.to('conductor_' + updated.conductorId).emit('trip:status_changed', updated);
    res.json(updated);
});

app.put('/api/trips/:id/rating', async (req, res) => {
    const trip = await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { field, value } = req.body;
    const now = new Date().toISOString();
    const dbField = field === 'clientRating' ? 'clientrating' : 'conductorrating';
    const dbFieldAt = field === 'clientRating' ? 'clientratingat' : 'conductorratingat';
    await dbRun(`UPDATE trips SET ${dbField} = $1, ${dbFieldAt} = $2 WHERE id = $3`, [value, now, req.params.id]);
    const userField = field === 'clientRating' ? 'clientid' : 'conductorid';
    const userId = trip[userField];
    const user = await dbGet('SELECT ratings FROM users WHERE id = $1', [userId]);
    if (user) {
        const ratings = typeof user.ratings === 'string' ? JSON.parse(user.ratings || '[]') : (user.ratings || []);
        ratings.push(value);
        await dbRun('UPDATE users SET ratings = $1 WHERE id = $2', [JSON.stringify(ratings), userId]);
    }
    const updatedTrip = await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (updatedTrip.clientrating && updatedTrip.conductorrating) {
        await dbRun('UPDATE trips SET status = $1 WHERE id = $2', ['calificado', req.params.id]);
        await dbRun('UPDATE users SET available = 1 WHERE id = $1', [updatedTrip.conductorid]);
    }
    const final = parseTrip(await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.id]));
    io.emit('trip:rated', final);
    io.to('client_' + final.clientId).emit('trip:rated', final);
    io.to('conductor_' + final.conductorId).emit('trip:rated', final);
    res.json(final);
});

// === CONFIG ===
app.get('/api/config', async (req, res) => res.json(await getConfig()));
app.get('/api/rkm-config', async (req, res) => res.json(await getConfig()));

app.put('/api/config', async (req, res) => {
    for (const [k, v] of Object.entries(req.body)) {
        await dbRun('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [k, String(v)]);
    }
    io.emit('config:updated', await getConfig());
    res.json(await getConfig());
});

app.get('/api/fare-info', async (req, res) => {
    const fareInfo = getFarePeriod();
    const config = await getConfig();
    res.json({ ...fareInfo, bcvRate: parseFloat(config.bcvRate) || 36.50, rates: KILOMETER_RATE, bcvLastUpdate: config.bcvLastUpdate || null });
});

// === PAYMENTS ===
app.post('/api/payments/rkm', async (req, res) => {
    const { tripId } = req.body;
    const trip = await dbGet('SELECT * FROM trips WHERE id = $1', [tripId]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const client = await dbGet('SELECT * FROM users WHERE id = $1', [trip.clientid]);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (client.balance < trip.price) return res.status(400).json({ error: 'Saldo insuficiente' });
    const newClientBalance = parseFloat((client.balance - trip.price).toFixed(2));
    await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newClientBalance, trip.clientid]);
    const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]);
    if (conductor) {
        const newCondBalance = parseFloat((conductor.balance + trip.price).toFixed(2));
        await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newCondBalance, trip.conductorid]);
    }
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((trip.price * rate).toFixed(2));
    await dbRun('INSERT INTO transactions (id, tripid, clientid, conductorid, amount, amountbs, method, status, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        ['TXN_' + Date.now(), tripId, trip.clientid, trip.conductorid, trip.price, amountBs, 'rkm', 'completado', now]);
    await dbRun('UPDATE trips SET paymentstatus = $1, status = $2, completedat = $3 WHERE id = $4', ['pagado', 'completado', now, tripId]);
    io.emit('payment:completed', { tripId, method: 'rkm' });
    const updatedClient = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.clientid]));
    const updatedConductor = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]));
    io.to('client_' + trip.clientid).emit('user:updated', updatedClient);
    io.to('conductor_' + trip.conductorid).emit('user:updated', updatedConductor);
    res.json({ success: true });
});

app.post('/api/payments/pago_movil', async (req, res) => {
    const { tripId, phone, bankCode, reference } = req.body;
    const trip = await dbGet('SELECT * FROM trips WHERE id = $1', [tripId]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((trip.price * rate).toFixed(2));
    await dbRun('INSERT INTO transactions (id, tripid, clientid, conductorid, amount, amountbs, method, status, reference, phone, bankcode, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        ['TXN_' + Date.now(), tripId, trip.clientid, trip.conductorid, trip.price, amountBs, 'pago_movil', 'completado', reference, phone, bankCode, now]);
    await dbRun('UPDATE trips SET paymentstatus = $1, status = $2, completedat = $3 WHERE id = $4', ['pagado', 'completado', now, tripId]);
    io.emit('payment:completed', { tripId, method: 'pago_movil' });
    res.json({ success: true });
});

// === WALLET RECHARGE ===
app.post('/api/wallet/recharge', async (req, res) => {
    const { userId, amount, phone, bankCode, reference } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    const id = 'RCH_' + Date.now();
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((amount * rate).toFixed(2));
    await dbRun('INSERT INTO recharges (id, userid, username, amount, amountbs, phone, bankcode, reference, status, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [id, userId, user.name, amount, amountBs, phone, bankCode, reference, 'pendiente', now]);
    io.emit('recharge:created', { id, userId, userName: user.name, amount, amountBs, status: 'pendiente' });
    res.json({ success: true, id, message: 'Solicitud de recarga enviada.' });
});

app.get('/api/wallet/recharges', async (req, res) => {
    const rows = await dbAll('SELECT * FROM recharges ORDER BY createdat DESC');
    res.json(rows.map(r => mapRow(r, RECHARGE_MAP)));
});

app.put('/api/wallet/recharges/:id', async (req, res) => {
    const { status, adminNote } = req.body;
    const recharge = await dbGet('SELECT * FROM recharges WHERE id = $1', [req.params.id]);
    if (!recharge) return res.status(404).json({ error: 'Recarga no encontrada' });
    const now = new Date().toISOString();
    await dbRun('UPDATE recharges SET status = $1, adminnote = $2, reviewedat = $3 WHERE id = $4', [status, adminNote || '', now, req.params.id]);
    if (status === 'aprobada') {
        const user = await dbGet('SELECT * FROM users WHERE id = $1', [recharge.userid]);
        if (user) {
            const newBalance = parseFloat((user.balance + recharge.amount).toFixed(2));
            await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, recharge.userid]);
            const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [recharge.userid]));
            io.to('client_' + recharge.userid).emit('user:updated', updated);
            io.to('client_' + recharge.userid).emit('recharge:approved', { amount: recharge.amount });
        }
    }
    io.emit('recharge:updated', { id: req.params.id, status });
    res.json({ success: true });
});

// === WALLET WITHDRAWAL ===
app.post('/api/wallet/withdraw', async (req, res) => {
    const { conductorId, amount } = req.body;
    const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [conductorId]);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    if (conductor.balance < amount) return res.status(400).json({ error: 'Saldo insuficiente' });
    const bankInfo = typeof conductor.bankinfo === 'string' ? JSON.parse(conductor.bankinfo || '{}') : (conductor.bankinfo || {});
    if (!bankInfo.bank || !bankInfo.account) return res.status(400).json({ error: 'Configura tu cuenta bancaria primero' });
    const config = await getConfig();
    const commissionPct = parseFloat(config.withdrawalCommission || '10');
    const commission = parseFloat((amount * commissionPct / 100).toFixed(2));
    const netAmount = parseFloat((amount - commission).toFixed(2));
    const id = 'WDR_' + Date.now();
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((amount * rate).toFixed(2));
    await dbRun('INSERT INTO withdrawals (id, conductorid, conductorname, amount, amountbs, commission, netamount, bankinfo, status, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [id, conductorId, conductor.name, amount, amountBs, commission, netAmount, JSON.stringify(bankInfo), 'pendiente', now]);
    await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [parseFloat((conductor.balance - amount).toFixed(2)), conductorId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [conductorId]));
    io.to('conductor_' + conductorId).emit('user:updated', updated);
    io.emit('withdrawal:created', { id, conductorId, conductorName: conductor.name, amount, amountBs, commission, netAmount, status: 'pendiente' });
    res.json({ success: true, id, message: 'Solicitud de retiro enviada.' });
});

app.get('/api/wallet/withdrawals', async (req, res) => {
    const rows = await dbAll('SELECT * FROM withdrawals ORDER BY createdat DESC');
    res.json(rows.map(r => mapRow(r, WITHDRAWAL_MAP)));
});

app.put('/api/wallet/withdrawals/:id', async (req, res) => {
    const { status, adminNote, reference } = req.body;
    const withdrawal = await dbGet('SELECT * FROM withdrawals WHERE id = $1', [req.params.id]);
    if (!withdrawal) return res.status(404).json({ error: 'Retiro no encontrado' });
    const now = new Date().toISOString();
    if (reference) {
        await dbRun('UPDATE withdrawals SET status = $1, adminnote = $2, reviewedat = $3, reference = $4 WHERE id = $5',
            [status, adminNote || '', now, reference, req.params.id]);
    } else {
        await dbRun('UPDATE withdrawals SET status = $1, adminnote = $2, reviewedat = $3 WHERE id = $4',
            [status, adminNote || '', now, req.params.id]);
    }
    if (status === 'rechazada') {
        const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [withdrawal.conductorid]);
        if (conductor) {
            const newBalance = parseFloat((conductor.balance + withdrawal.amount).toFixed(2));
            await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, withdrawal.conductorid]);
            const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [withdrawal.conductorid]));
            io.to('conductor_' + withdrawal.conductorid).emit('user:updated', updated);
            io.to('conductor_' + withdrawal.conductorid).emit('withdrawal:rejected', { amount: withdrawal.amount, reason: adminNote });
        }
    } else if (status === 'aprobada') {
        io.to('conductor_' + withdrawal.conductorid).emit('withdrawal:approved', { amount: withdrawal.amount, netAmount: withdrawal.netamount });
    } else if (status === 'realizado') {
        io.to('conductor_' + withdrawal.conductorid).emit('withdrawal:realized', { amount: withdrawal.amount, netAmount: withdrawal.netamount, reference: reference || 'Sin referencia', note: adminNote });
    }
    io.emit('withdrawal:updated', { id: req.params.id, status });
    res.json({ success: true });
});

// === TRANSACTIONS ===
app.get('/api/transactions', async (req, res) => {
    const rows = await dbAll('SELECT * FROM transactions ORDER BY createdat DESC');
    res.json(rows.map(r => mapRow(r, TXN_MAP)));
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    socket.on('join', (room) => { socket.join(room); });
    socket.on('disconnect', () => { console.log('Disconnected:', socket.id); });
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`TuRides server running on http://localhost:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
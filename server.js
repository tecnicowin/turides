const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { dbRun, dbGet, dbAll, dbExec } = require('./db');

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

async function initDB() {
    await dbExec(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT UNIQUE, password TEXT,
        role TEXT, available INTEGER DEFAULT 0, vehicle TEXT, tariffMode TEXT,
        fixedTariffs TEXT, balance REAL DEFAULT 0, bankInfo TEXT, ratings TEXT DEFAULT '[]',
        twoFactorSecret TEXT, twoFactorEnabled INTEGER DEFAULT 0, passwordChanged INTEGER DEFAULT 0
    )`);
    await dbExec(`CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY, clientId TEXT, clientName TEXT, clientPhone TEXT,
        originAddress TEXT, destinationAddress TEXT, distance REAL,
        conductorId TEXT, conductorName TEXT, conductorPhone TEXT, conductorVehicle TEXT,
        price REAL, priceBs REAL, paymentMethod TEXT, status TEXT DEFAULT 'pendiente',
        paymentStatus TEXT, clientRating INTEGER, conductorRating INTEGER,
        clientRatingAt TEXT, conductorRatingAt TEXT, createdAt TEXT, completedAt TEXT,
        paymentVerifiedAt TEXT, fareMultiplier REAL DEFAULT 1.0, farePeriod TEXT DEFAULT 'normal'
    )`);
    await dbExec(`CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, tripId TEXT, clientId TEXT, conductorId TEXT,
        amount REAL, amountBs REAL, method TEXT, status TEXT,
        reference TEXT, phone TEXT, bankCode TEXT, createdAt TEXT
    )`);
    await dbExec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
    await dbExec(`CREATE TABLE IF NOT EXISTS recharges (
        id TEXT PRIMARY KEY, userId TEXT, userName TEXT, amount REAL, amountBs REAL,
        phone TEXT, bankCode TEXT, reference TEXT, status TEXT DEFAULT 'pendiente',
        adminNote TEXT, createdAt TEXT, reviewedAt TEXT
    )`);
    await dbExec(`CREATE TABLE IF NOT EXISTS withdrawals (
        id TEXT PRIMARY KEY, conductorId TEXT, conductorName TEXT,
        amount REAL, amountBs REAL, commission REAL DEFAULT 0, netAmount REAL DEFAULT 0,
        bankInfo TEXT, status TEXT DEFAULT 'pendiente', adminNote TEXT,
        reference TEXT, createdAt TEXT, reviewedAt TEXT
    )`);

    const existingConfig = await dbAll('SELECT key FROM config LIMIT 1');
    if (existingConfig.length === 0) {
        for (const [k, v] of Object.entries(SEED_CONFIG)) {
            await dbRun('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', [k, v]);
        }
    }

    const userCount = await dbGet('SELECT COUNT(*) as c FROM users');
    console.log(`Database ready. Users: ${userCount.c}`);
}

function parseUser(row) {
    if (!row) return null;
    const { password, twoFactorSecret, ...safe } = row;
    safe.available = !!safe.available;
    safe.twoFactorEnabled = !!safe.twoFactorEnabled;
    safe.passwordChanged = !!safe.passwordChanged;
    if (safe.vehicle) { try { safe.vehicle = typeof safe.vehicle === 'string' ? JSON.parse(safe.vehicle) : safe.vehicle; } catch(e) { safe.vehicle = null; } }
    if (safe.fixedTariffs) { try { safe.fixedTariffs = typeof safe.fixedTariffs === 'string' ? JSON.parse(safe.fixedTariffs) : safe.fixedTariffs; } catch(e) { safe.fixedTariffs = {}; } }
    if (safe.ratings) { try { safe.ratings = typeof safe.ratings === 'string' ? JSON.parse(safe.ratings) : safe.ratings; } catch(e) { safe.ratings = []; } }
    if (safe.bankInfo) { try { safe.bankInfo = typeof safe.bankInfo === 'string' ? JSON.parse(safe.bankInfo) : safe.bankInfo; } catch(e) { safe.bankInfo = {}; } }
    return safe;
}

function parseTrip(row) {
    if (!row) return null;
    row.clientRating = row.clientRating || null;
    row.conductorRating = row.conductorRating || null;
    row.fareMultiplier = row.fareMultiplier || 1.0;
    row.farePeriod = row.farePeriod || 'normal';
    return row;
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
    const row = await dbGet('SELECT * FROM users WHERE email = ? AND password = ?', [email.toLowerCase(), password]);
    if (!row) return res.status(401).json({ error: 'Credenciales incorrectas' });
    if (row.twoFactorEnabled) return res.json({ twoFactorRequired: true, userId: row.id });
    res.json(parseUser(row));
});

app.post('/api/login/2fa-verify', async (req, res) => {
    const { userId, code } = req.body;
    const OTPAuth = require('otpauth');
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (!row.twoFactorEnabled || !row.twoFactorSecret) return res.status(400).json({ error: '2FA no activo' });
    const totp = new OTPAuth.TOTP({ issuer: 'TuRides', label: row.email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.twoFactorSecret) });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) return res.status(401).json({ error: 'Codigo 2FA incorrecto' });
    res.json(parseUser(row));
});

app.post('/api/register', async (req, res) => {
    const { name, phone, email, password, role, vehicleData } = req.body;
    const exists = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (exists) return res.status(400).json({ error: 'El correo ya esta registrado' });
    const vehicle = role === 'conductor' && vehicleData ? JSON.stringify({ type: vehicleData.type || 'carro', brand: vehicleData.brand, model: vehicleData.model, passengers: parseInt(vehicleData.passengers) || 4, suitcases: parseInt(vehicleData.suitcases) || 2 }) : null;
    const tariffMode = role === 'conductor' ? (vehicleData?.tariffMode || 'kilometros') : null;
    const fixedTariffs = role === 'conductor' ? JSON.stringify({ defaultPrice: 20.00 }) : null;
    await dbRun('INSERT INTO users (id, name, phone, email, password, role, available, vehicle, tariffMode, fixedTariffs, balance, ratings, bankInfo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
        [email, name, phone, email.toLowerCase(), password, role, 0, vehicle, tariffMode, fixedTariffs, '[]', '{}']);
    const user = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [email]));
    io.emit('user:created', user);
    res.json(user);
});

// === SETUP ===
app.get('/api/setup/status', async (req, res) => {
    const adminCount = await dbGet("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
    const userCount = await dbGet('SELECT COUNT(*) as c FROM users');
    res.json({ hasAdmin: adminCount.c > 0, totalUsers: userCount.c });
});

app.post('/api/setup/admin', async (req, res) => {
    const adminCount = await dbGet("SELECT COUNT(*) as c FROM users WHERE role = 'admin'");
    if (adminCount.c > 0) return res.status(400).json({ error: 'Ya existe un administrador.' });
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    const id = email.toLowerCase();
    await dbRun('INSERT INTO users (id, name, phone, email, password, role, available, balance, ratings, bankInfo, passwordChanged) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1)',
        [id, name, phone || null, email.toLowerCase(), password, 'admin', 0, '[]', '{}']);
    const user = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [id]));
    io.emit('user:created', user);
    res.json(user);
});

app.post('/api/change-password', async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (row.password !== currentPassword) return res.status(401).json({ error: 'Contrasena actual incorrecta' });
    if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: 'Minimo 3 caracteres' });
    await dbRun('UPDATE users SET password = ?, passwordChanged = 1 WHERE id = ?', [newPassword, userId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [userId]));
    io.emit('user:updated', updated);
    res.json({ success: true, message: 'Contrasena actualizada' });
});

// === 2FA ===
app.post('/api/2fa/setup', async (req, res) => {
    const OTPAuth = require('otpauth');
    const QRCode = require('qrcode');
    const { userId } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (row.twoFactorEnabled) return res.status(400).json({ error: '2FA ya activo' });
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({ issuer: 'TuRides', label: row.email, algorithm: 'SHA1', digits: 6, period: 30, secret });
    await dbRun('UPDATE users SET twoFactorSecret = ? WHERE id = ?', [secret.base32, userId]);
    const otpauthUrl = totp.toString();
    QRCode.toDataURL(otpauthUrl, (err, dataUrl) => {
        if (err) return res.status(500).json({ error: 'Error generando QR' });
        res.json({ secret: secret.base32, qrCode: dataUrl, otpauthUrl });
    });
});

app.post('/api/2fa/verify-and-enable', async (req, res) => {
    const OTPAuth = require('otpauth');
    const { userId, code } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!row.twoFactorSecret) return res.status(400).json({ error: 'Primero genera un secreto 2FA' });
    const totp = new OTPAuth.TOTP({ issuer: 'TuRides', label: row.email, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(row.twoFactorSecret) });
    if (totp.validate({ token: code, window: 1 }) === null) return res.status(400).json({ error: 'Codigo incorrecto' });
    await dbRun('UPDATE users SET twoFactorEnabled = 1 WHERE id = ?', [userId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [userId]));
    io.emit('user:updated', updated);
    res.json({ success: true, message: '2FA activado' });
});

app.post('/api/2fa/disable', async (req, res) => {
    const { userId, password } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (row.password !== password) return res.status(401).json({ error: 'Contrasena incorrecta' });
    await dbRun('UPDATE users SET twoFactorEnabled = 0, twoFactorSecret = NULL WHERE id = ?', [userId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [userId]));
    io.emit('user:updated', updated);
    res.json({ success: true, message: '2FA desactivado' });
});

app.post('/api/setup/reset', (req, res) => {
    return res.status(403).json({ error: 'Funcion deshabilitada por seguridad.' });
});

// === USERS ===
app.get('/api/users', async (req, res) => {
    const rows = await dbAll('SELECT * FROM users');
    res.json(rows.map(parseUser));
});

app.get('/api/users/:id', async (req, res) => {
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(parseUser(row));
});

app.put('/api/users/:id', async (req, res) => {
    const row = await dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    const updates = req.body;
    if (updates.vehicle && typeof updates.vehicle === 'object') updates.vehicle = JSON.stringify(updates.vehicle);
    if (updates.fixedTariffs && typeof updates.fixedTariffs === 'object') updates.fixedTariffs = JSON.stringify(updates.fixedTariffs);
    if (updates.ratings && Array.isArray(updates.ratings)) updates.ratings = JSON.stringify(updates.ratings);
    if (updates.bankInfo && typeof updates.bankInfo === 'object') updates.bankInfo = JSON.stringify(updates.bankInfo);
    if (updates.available !== undefined) updates.available = updates.available ? 1 : 0;
    const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'password' && k !== 'twoFactorSecret' && k !== 'twoFactorEnabled' && k !== 'passwordChanged');
    if (fields.length === 0) return res.json(parseUser(row));
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => updates[f]);
    await dbRun(`UPDATE users SET ${setClause} WHERE id = ?`, [...values, req.params.id]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [req.params.id]));
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
        const vehicle = typeof c.vehicle === 'string' ? JSON.parse(c.vehicle || '{}') : (c.vehicle || {});
        const fixedTariffs = typeof c.fixedTariffs === 'string' ? JSON.parse(c.fixedTariffs || '{}') : (c.fixedTariffs || {});
        const ratings = typeof c.ratings === 'string' ? JSON.parse(c.ratings || '[]') : (c.ratings || []);
        let price = 0;
        const rates = KILOMETER_RATE[vehicle.type] || KILOMETER_RATE.carro;
        if (c.tariffMode === 'fijo') {
            price = parseFloat(fixedTariffs.defaultPrice) || 35.00;
        } else {
            price = rates.base;
            if (distance > rates.minDistance) price += (distance - rates.minDistance) * rates.perKm;
        }
        price = parseFloat((price * fareInfo.multiplier).toFixed(2));
        const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
        return { ...parseUser(c), calculatedPrice: price, calculatedPriceBs: price * 36.50, avgRating, ratingCount: ratings.length, farePeriod: fareInfo.period, fareMultiplier: fareInfo.multiplier };
    });
    res.json(conductors);
});

// === TRIPS ===
app.get('/api/trips', async (req, res) => {
    const rows = await dbAll('SELECT * FROM trips ORDER BY createdAt DESC');
    res.json(rows.map(parseTrip));
});

app.post('/api/trips', async (req, res) => {
    const { clientId, clientName, clientPhone, originAddress, destinationAddress, distance, conductorId, price, paymentMethod } = req.body;
    const conductor = await dbGet('SELECT * FROM users WHERE id = ?', [conductorId]);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    const vehicle = typeof conductor.vehicle === 'string' ? JSON.parse(conductor.vehicle || '{}') : (conductor.vehicle || {});
    const id = 'TRIP_' + Date.now();
    const now = new Date().toISOString();
    const fareInfo = getFarePeriod();
    const finalPrice = parseFloat((price * fareInfo.multiplier).toFixed(2));
    const rate = await getBCVRate();
    const priceBs = parseFloat((finalPrice * rate).toFixed(2));
    await dbRun('INSERT INTO trips (id, clientId, clientName, clientPhone, originAddress, destinationAddress, distance, conductorId, conductorName, conductorPhone, conductorVehicle, price, priceBs, paymentMethod, status, createdAt, fareMultiplier, farePeriod) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, clientId, clientName, clientPhone, originAddress, destinationAddress, parseFloat(distance), conductorId, conductor.name, conductor.phone, `${vehicle.brand} ${vehicle.model}`, finalPrice, priceBs, paymentMethod, 'pendiente', now, fareInfo.multiplier, fareInfo.period]);
    const trip = parseTrip(await dbGet('SELECT * FROM trips WHERE id = ?', [id]));
    io.emit('trip:created', trip);
    io.to('conductor_' + conductorId).emit('trip:new_request', trip);
    res.json(trip);
});

app.put('/api/trips/:id/status', async (req, res) => {
    const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [req.params.id]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { status } = req.body;
    const now = new Date().toISOString();
    if (status === 'completado') {
        await dbRun('UPDATE trips SET status = ?, completedAt = ? WHERE id = ?', [status, now, req.params.id]);
    } else if (status === 'pago_verificado') {
        await dbRun('UPDATE trips SET status = ?, paymentVerifiedAt = ? WHERE id = ?', [status, now, req.params.id]);
    } else if (status === 'aceptado') {
        await dbRun('UPDATE trips SET status = ? WHERE id = ?', [status, req.params.id]);
        await dbRun('UPDATE users SET available = 0 WHERE id = ?', [trip.conductorId]);
    } else if (status === 'calificado') {
        await dbRun('UPDATE trips SET status = ? WHERE id = ?', [status, req.params.id]);
        await dbRun('UPDATE users SET available = 1 WHERE id = ?', [trip.conductorId]);
    } else {
        await dbRun('UPDATE trips SET status = ? WHERE id = ?', [status, req.params.id]);
    }
    const updated = parseTrip(await dbGet('SELECT * FROM trips WHERE id = ?', [req.params.id]));
    io.emit('trip:status_changed', updated);
    io.to('client_' + updated.clientId).emit('trip:status_changed', updated);
    io.to('conductor_' + updated.conductorId).emit('trip:status_changed', updated);
    res.json(updated);
});

app.put('/api/trips/:id/rating', async (req, res) => {
    const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [req.params.id]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { field, value } = req.body;
    const now = new Date().toISOString();
    await dbRun(`UPDATE trips SET ${field} = ?, ${field}At = ? WHERE id = ?`, [value, now, req.params.id]);
    const userField = field === 'clientRating' ? 'clientId' : 'conductorId';
    const userId = trip[userField];
    const user = await dbGet('SELECT ratings FROM users WHERE id = ?', [userId]);
    if (user) {
        const ratings = typeof user.ratings === 'string' ? JSON.parse(user.ratings || '[]') : (user.ratings || []);
        ratings.push(value);
        await dbRun('UPDATE users SET ratings = ? WHERE id = ?', [JSON.stringify(ratings), userId]);
    }
    const updatedTrip = await dbGet('SELECT * FROM trips WHERE id = ?', [req.params.id]);
    if (updatedTrip.clientRating && updatedTrip.conductorRating) {
        await dbRun('UPDATE trips SET status = ? WHERE id = ?', ['calificado', req.params.id]);
        await dbRun('UPDATE users SET available = 1 WHERE id = ?', [updatedTrip.conductorId]);
    }
    const final = parseTrip(await dbGet('SELECT * FROM trips WHERE id = ?', [req.params.id]));
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
        await dbRun('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [k, String(v)]);
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
    const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const client = await dbGet('SELECT * FROM users WHERE id = ?', [trip.clientId]);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (client.balance < trip.price) return res.status(400).json({ error: 'Saldo insuficiente' });
    const newClientBalance = parseFloat((client.balance - trip.price).toFixed(2));
    await dbRun('UPDATE users SET balance = ? WHERE id = ?', [newClientBalance, trip.clientId]);
    const conductor = await dbGet('SELECT * FROM users WHERE id = ?', [trip.conductorId]);
    if (conductor) {
        const newCondBalance = parseFloat((conductor.balance + trip.price).toFixed(2));
        await dbRun('UPDATE users SET balance = ? WHERE id = ?', [newCondBalance, trip.conductorId]);
    }
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((trip.price * rate).toFixed(2));
    await dbRun('INSERT INTO transactions (id, tripId, clientId, conductorId, amount, amountBs, method, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['TXN_' + Date.now(), tripId, trip.clientId, trip.conductorId, trip.price, amountBs, 'rkm', 'completado', now]);
    await dbRun('UPDATE trips SET paymentStatus = ?, status = ?, completedAt = ? WHERE id = ?', ['pagado', 'completado', now, tripId]);
    io.emit('payment:completed', { tripId, method: 'rkm' });
    const updatedClient = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [trip.clientId]));
    const updatedConductor = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [trip.conductorId]));
    io.to('client_' + trip.clientId).emit('user:updated', updatedClient);
    io.to('conductor_' + trip.conductorId).emit('user:updated', updatedConductor);
    res.json({ success: true });
});

app.post('/api/payments/pago_movil', async (req, res) => {
    const { tripId, phone, bankCode, reference } = req.body;
    const trip = await dbGet('SELECT * FROM trips WHERE id = ?', [tripId]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((trip.price * rate).toFixed(2));
    await dbRun('INSERT INTO transactions (id, tripId, clientId, conductorId, amount, amountBs, method, status, reference, phone, bankCode, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['TXN_' + Date.now(), tripId, trip.clientId, trip.conductorId, trip.price, amountBs, 'pago_movil', 'completado', reference, phone, bankCode, now]);
    await dbRun('UPDATE trips SET paymentStatus = ?, status = ?, completedAt = ? WHERE id = ?', ['pagado', 'completado', now, tripId]);
    io.emit('payment:completed', { tripId, method: 'pago_movil' });
    res.json({ success: true });
});

// === WALLET RECHARGE ===
app.post('/api/wallet/recharge', async (req, res) => {
    const { userId, amount, phone, bankCode, reference } = req.body;
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    const id = 'RCH_' + Date.now();
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((amount * rate).toFixed(2));
    await dbRun('INSERT INTO recharges (id, userId, userName, amount, amountBs, phone, bankCode, reference, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, userId, user.name, amount, amountBs, phone, bankCode, reference, 'pendiente', now]);
    io.emit('recharge:created', { id, userId, userName: user.name, amount, amountBs, status: 'pendiente' });
    res.json({ success: true, id, message: 'Solicitud de recarga enviada.' });
});

app.get('/api/wallet/recharges', async (req, res) => {
    res.json(await dbAll('SELECT * FROM recharges ORDER BY createdAt DESC'));
});

app.put('/api/wallet/recharges/:id', async (req, res) => {
    const { status, adminNote } = req.body;
    const recharge = await dbGet('SELECT * FROM recharges WHERE id = ?', [req.params.id]);
    if (!recharge) return res.status(404).json({ error: 'Recarga no encontrada' });
    const now = new Date().toISOString();
    await dbRun('UPDATE recharges SET status = ?, adminNote = ?, reviewedAt = ? WHERE id = ?', [status, adminNote || '', now, req.params.id]);
    if (status === 'aprobada') {
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [recharge.userId]);
        if (user) {
            const newBalance = parseFloat((user.balance + recharge.amount).toFixed(2));
            await dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBalance, recharge.userId]);
            const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [recharge.userId]));
            io.to('client_' + recharge.userId).emit('user:updated', updated);
            io.to('client_' + recharge.userId).emit('recharge:approved', { amount: recharge.amount });
        }
    }
    io.emit('recharge:updated', { id: req.params.id, status });
    res.json({ success: true });
});

// === WALLET WITHDRAWAL ===
app.post('/api/wallet/withdraw', async (req, res) => {
    const { conductorId, amount } = req.body;
    const conductor = await dbGet('SELECT * FROM users WHERE id = ?', [conductorId]);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    if (conductor.balance < amount) return res.status(400).json({ error: 'Saldo insuficiente' });
    const bankInfo = typeof conductor.bankInfo === 'string' ? JSON.parse(conductor.bankInfo || '{}') : (conductor.bankInfo || {});
    if (!bankInfo.bank || !bankInfo.account) return res.status(400).json({ error: 'Configura tu cuenta bancaria primero' });
    const config = await getConfig();
    const commissionPct = parseFloat(config.withdrawalCommission || '10');
    const commission = parseFloat((amount * commissionPct / 100).toFixed(2));
    const netAmount = parseFloat((amount - commission).toFixed(2));
    const id = 'WDR_' + Date.now();
    const now = new Date().toISOString();
    const rate = await getBCVRate();
    const amountBs = parseFloat((amount * rate).toFixed(2));
    await dbRun('INSERT INTO withdrawals (id, conductorId, conductorName, amount, amountBs, commission, netAmount, bankInfo, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, conductorId, conductor.name, amount, amountBs, commission, netAmount, JSON.stringify(bankInfo), 'pendiente', now]);
    await dbRun('UPDATE users SET balance = ? WHERE id = ?', [parseFloat((conductor.balance - amount).toFixed(2)), conductorId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [conductorId]));
    io.to('conductor_' + conductorId).emit('user:updated', updated);
    io.emit('withdrawal:created', { id, conductorId, conductorName: conductor.name, amount, amountBs, commission, netAmount, status: 'pendiente' });
    res.json({ success: true, id, message: 'Solicitud de retiro enviada.' });
});

app.get('/api/wallet/withdrawals', async (req, res) => {
    res.json(await dbAll('SELECT * FROM withdrawals ORDER BY createdAt DESC'));
});

app.put('/api/wallet/withdrawals/:id', async (req, res) => {
    const { status, adminNote, reference } = req.body;
    const withdrawal = await dbGet('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
    if (!withdrawal) return res.status(404).json({ error: 'Retiro no encontrado' });
    const now = new Date().toISOString();
    await dbRun('UPDATE withdrawals SET status = ?, adminNote = ?, reviewedAt = ?, reference = COALESCE(?, reference) WHERE id = ?',
        [status, adminNote || '', now, reference || null, req.params.id]);
    if (status === 'rechazada') {
        const conductor = await dbGet('SELECT * FROM users WHERE id = ?', [withdrawal.conductorId]);
        if (conductor) {
            const newBalance = parseFloat((conductor.balance + withdrawal.amount).toFixed(2));
            await dbRun('UPDATE users SET balance = ? WHERE id = ?', [newBalance, withdrawal.conductorId]);
            const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = ?', [withdrawal.conductorId]));
            io.to('conductor_' + withdrawal.conductorId).emit('user:updated', updated);
            io.to('conductor_' + withdrawal.conductorId).emit('withdrawal:rejected', { amount: withdrawal.amount, reason: adminNote });
        }
    } else if (status === 'aprobada') {
        io.to('conductor_' + withdrawal.conductorId).emit('withdrawal:approved', { amount: withdrawal.amount, netAmount: withdrawal.netAmount });
    } else if (status === 'realizado') {
        io.to('conductor_' + withdrawal.conductorId).emit('withdrawal:realized', { amount: withdrawal.amount, netAmount: withdrawal.netAmount, reference: reference || 'Sin referencia', note: adminNote });
    }
    io.emit('withdrawal:updated', { id: req.params.id, status });
    res.json({ success: true });
});

// === TRANSACTIONS ===
app.get('/api/transactions', async (req, res) => {
    res.json(await dbAll('SELECT * FROM transactions ORDER BY createdAt DESC'));
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

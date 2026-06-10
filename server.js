const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const PDFDocument = require('pdfkit');
const { dbRun, dbGet, dbAll, dbExec, dbClientExec } = require('./db');

const BCRYPT_ROUNDS = 10;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(express.json());

// Redirigir la raiz a la landing page (ANTES de static para priorizar)
app.get('/', (req, res) => {
    res.redirect('/landing.html');
});

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

async function requireAuth(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'No autenticado' });
    const user = await dbGet('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    req.authUser = user;
    next();
}

async function requireAdmin(req, res, next) {
    const userId = req.headers['x-user-id'];
    if (!userId) return res.status(401).json({ error: 'No autenticado' });
    const user = await dbGet('SELECT id, role FROM users WHERE id = $1', [userId]);
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
    if (user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
    req.authUser = user;
    next();
}

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
    fareperiod: 'farePeriod', orderdetails: 'orderDetails', platformcommission: 'platformCommission'
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
        await client.query(`CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, name TEXT, phone TEXT, email TEXT UNIQUE, password TEXT,
            role TEXT, available INTEGER DEFAULT 0, vehicle TEXT, tariffmode TEXT,
            fixedtariffs TEXT, balance REAL DEFAULT 0, bankinfo TEXT, ratings TEXT DEFAULT '[]',
            twofactorsecret TEXT, twofactorenabled INTEGER DEFAULT 0, passwordchanged INTEGER DEFAULT 0
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS trips (
            id TEXT PRIMARY KEY, clientid TEXT, clientname TEXT, clientphone TEXT,
            originaddress TEXT, destinationaddress TEXT, distance REAL,
            conductorid TEXT, conductorname TEXT, conductorphone TEXT, conductorvehicle TEXT,
            price REAL, pricebs REAL, paymentmethod TEXT, status TEXT DEFAULT 'pendiente',
            paymentstatus TEXT, clientrating INTEGER, conductorrating INTEGER,
            clientratingat TEXT, conductorratingat TEXT, createdat TEXT, completedat TEXT,
            paymentverifiedat TEXT, faremultiplier REAL DEFAULT 1.0, fareperiod TEXT DEFAULT 'normal',
            orderdetails TEXT, platformcommission REAL DEFAULT 0
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY, tripid TEXT, clientid TEXT, conductorid TEXT,
            amount REAL, amountbs REAL, method TEXT, status TEXT,
            reference TEXT, phone TEXT, bankcode TEXT, createdat TEXT
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
        await client.query(`CREATE TABLE IF NOT EXISTS recharges (
            id TEXT PRIMARY KEY, userid TEXT, username TEXT, amount REAL, amountbs REAL,
            phone TEXT, bankcode TEXT, reference TEXT, status TEXT DEFAULT 'pendiente',
            adminnote TEXT, createdat TEXT, reviewedat TEXT
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS withdrawals (
            id TEXT PRIMARY KEY, conductorid TEXT, conductorname TEXT,
            amount REAL, amountbs REAL, commission REAL DEFAULT 0, netamount REAL DEFAULT 0,
            bankinfo TEXT, status TEXT DEFAULT 'pendiente', adminnote TEXT,
            reference TEXT, createdat TEXT, reviewedat TEXT
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS pass_purchases (
            id TEXT PRIMARY KEY, userid TEXT, username TEXT, passlevel TEXT,
            amount REAL, creditapplied REAL DEFAULT 0, paymentmethod TEXT,
            status TEXT DEFAULT 'completado', createdat TEXT
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS referrals (
            id TEXT PRIMARY KEY, referrerid TEXT, referrername TEXT,
            referredid TEXT, referredname TEXT, referredemail TEXT,
            passamount REAL DEFAULT 0, commission REAL DEFAULT 5,
            status TEXT DEFAULT 'pendiente', createdat TEXT
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
    if (m.orderDetails && typeof m.orderDetails === 'string') {
        try { m.orderDetails = JSON.parse(m.orderDetails); } catch(e) { m.orderDetails = null; }
    }
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
    camioneta: { base: 4.50, perKm: 0.90, minDistance: 2.5 },
    moto: { base: 0.80, perKm: 0.40, minDistance: 2.5 },
    moto_delivery: { base: 1.80, perKm: 0.55, minDistance: 2.5 },
    mensajero: { base: 0.50, perKm: 1.00, minDistance: 0.3, maxDistance: 3.0 },
    mudanza_pickup: { base: 50, perKm: 0, flatRate: true },
    mudanza_350: { base: 100, perKm: 0, flatRate: true },
    mudanza_750: { base: 180, perKm: 0, flatRate: true }
};

const MUDANZA_COMMISSION = {
    mudanza_pickup: 0.05,
    mudanza_350: 0.10,
    mudanza_750: 0.15
};

const PLATFORM_COMMISSION_RATE = 0.10;

// === AUTH ===
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!row) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const passwordMatch = await bcrypt.compare(password, row.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Credenciales incorrectas' });
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
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const vehicle = role === 'conductor' && vehicleData ? JSON.stringify({ type: vehicleData.type || 'carro', brand: vehicleData.brand, model: vehicleData.model, passengers: parseInt(vehicleData.passengers) || 4, suitcases: parseInt(vehicleData.suitcases) || 2 }) : role === 'mensajero' ? JSON.stringify({ type: 'mensajero', brand: 'N/A', model: 'A pie' }) : null;
    const tariffMode = role === 'conductor' ? (vehicleData?.tariffMode || 'kilometros') : null;
    const fixedTariffs = role === 'conductor' ? JSON.stringify({ defaultPrice: 20.00 }) : null;
    await dbRun('INSERT INTO users (id, name, phone, email, password, role, available, vehicle, tariffmode, fixedtariffs, balance, ratings, bankinfo) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12)',
        [email, name, phone, email.toLowerCase(), hashedPassword, role, 0, vehicle, tariffMode, fixedTariffs, '[]', '{}']);
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
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await dbRun('INSERT INTO users (id, name, phone, email, password, role, available, balance, ratings, bankinfo, passwordchanged) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, 1)',
        [id, name, phone || null, email.toLowerCase(), hashedPassword, 'admin', 0, '[]', '{}']);
    const user = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [id]));
    io.emit('user:created', user);
    res.json(user);
});

app.post('/api/change-password', async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [userId]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    const passwordMatch = await bcrypt.compare(currentPassword, row.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Contrasena actual incorrecta' });
    if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: 'Minimo 3 caracteres' });
    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await dbRun('UPDATE users SET password = $1, passwordchanged = 1 WHERE id = $2', [hashedPassword, userId]);
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
    const passwordMatch = await bcrypt.compare(password, row.password);
    if (!passwordMatch) return res.status(401).json({ error: 'Contrasena incorrecta' });
    await dbRun('UPDATE users SET twofactorenabled = 0, twofactorsecret = NULL WHERE id = $1', [userId]);
    const updated = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [userId]));
    io.emit('user:updated', updated);
    res.json({ success: true, message: '2FA desactivado' });
});

app.post('/api/setup/reset', (req, res) => {
    return res.status(403).json({ error: 'Funcion deshabilitada por seguridad.' });
});

// === USERS ===
app.get('/api/users', requireAuth, async (req, res) => {
    const rows = await dbAll('SELECT * FROM users');
    res.json(rows.map(r => parseUser(r)));
});

app.get('/api/users/:id', requireAuth, async (req, res) => {
    const row = await dbGet('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(parseUser(row));
});

app.put('/api/users/:id', requireAuth, async (req, res) => {
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
app.get('/api/conductors/available', requireAuth, async (req, res) => {
    const distance = parseFloat(req.query.distance) || 10;
    const vehicleType = req.query.vehicleType || 'carro';
    const rows = await dbAll("SELECT * FROM users WHERE role IN ('conductor', 'mensajero') AND available = 1");
    const fareInfo = getFarePeriod();
    const conductors = rows.filter(c => {
        const v = typeof c.vehicle === 'string' ? JSON.parse(c.vehicle || '{}') : (c.vehicle || {});
        if (vehicleType === 'mudanza' || vehicleType === 'mudanza_pickup' || vehicleType === 'mudanza_350' || vehicleType === 'mudanza_750') return v.type && (v.type.startsWith('mudanza_') || v.type === 'camioneta');
        if (vehicleType === 'moto') return v.type === 'moto' || v.type === 'moto_delivery' || v.type === 'moto_ambas';
        if (vehicleType === 'carro') return v.type === 'carro';
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
            if (rates.maxDistance && distance > rates.maxDistance) return null;
            if (rates.flatRate) {
                price = rates.base;
            } else {
                price = rates.base;
                if (distance > rates.minDistance) price += (distance - rates.minDistance) * rates.perKm;
            }
        }
        price = parseFloat((price * fareInfo.multiplier).toFixed(2));
        const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
        return { ...cu, calculatedPrice: price, calculatedPriceBs: price * 36.50, avgRating, ratingCount: ratings.length, farePeriod: fareInfo.period, fareMultiplier: fareInfo.multiplier };
    }).filter(Boolean);
    res.json(conductors);
});

// === TRIPS ===
app.get('/api/trips', requireAuth, async (req, res) => {
    const rows = await dbAll('SELECT * FROM trips ORDER BY createdat DESC');
    res.json(rows.map(r => parseTrip(r)));
});

app.post('/api/trips', requireAuth, async (req, res) => {
    const { clientId, clientName, clientPhone, originAddress, destinationAddress, distance, conductorId, price, paymentMethod, orderDetails } = req.body;
    const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [conductorId]);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    const vehicle = typeof conductor.vehicle === 'string' ? JSON.parse(conductor.vehicle || '{}') : (conductor.vehicle || {});
    const id = 'TRIP_' + Date.now();
    const now = new Date().toISOString();
    const fareInfo = getFarePeriod();
    const finalPrice = parseFloat((price * fareInfo.multiplier).toFixed(2));
    const rate = await getBCVRate();
    const priceBs = parseFloat((finalPrice * rate).toFixed(2));
    let orderDetailsJson = null;
    if (orderDetails && vehicle.type === 'mensajero') {
        orderDetailsJson = JSON.stringify({ ...orderDetails, orderId: 'MENS-' + Date.now().toString().slice(-8) });
    }
    let platformCommission = 0;
    const conductorPass = await getPassStatus(conductorId);
    const hasActivePass = !!conductorPass.activePass;
    if (hasActivePass) {
        platformCommission = 0;
    } else if (orderDetails && orderDetails.subtype && MUDANZA_COMMISSION[orderDetails.subtype]) {
        platformCommission = parseFloat((finalPrice * MUDANZA_COMMISSION[orderDetails.subtype]).toFixed(2));
    } else {
        platformCommission = parseFloat((finalPrice * PLATFORM_COMMISSION_RATE).toFixed(2));
    }
    await dbRun('INSERT INTO trips (id, clientid, clientname, clientphone, originaddress, destinationaddress, distance, conductorid, conductorname, conductorphone, conductorvehicle, price, pricebs, paymentmethod, status, createdat, faremultiplier, fareperiod, orderdetails, platformcommission) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)',
        [id, clientId, clientName, clientPhone, originAddress, destinationAddress, parseFloat(distance), conductorId, conductor.name, conductor.phone, `${vehicle.brand} ${vehicle.model}`, finalPrice, priceBs, paymentMethod, 'pendiente', now, fareInfo.multiplier, fareInfo.period, orderDetailsJson, platformCommission]);
    const trip = parseTrip(await dbGet('SELECT * FROM trips WHERE id = $1', [id]));
    io.emit('trip:created', trip);
    io.to('conductor_' + conductorId).emit('trip:new_request', trip);
    res.json(trip);
});

app.put('/api/trips/:id/status', requireAuth, async (req, res) => {
    const trip = await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.id]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { status } = req.body;
    const now = new Date().toISOString();
    if (status === 'completado') {
        const isMudanza = trip.orderdetails && (trip.paymentmethod === 'rkm' || trip.paymentmethod === 'efectivo' || trip.paymentmethod === 'pago_movil');
        if (trip.paymentmethod === 'rkm' && trip.paymentstatus !== 'pagado') {
            const client = await dbGet('SELECT * FROM users WHERE id = $1', [trip.clientid]);
            if (!client || client.balance < trip.price) {
                return res.status(400).json({ error: 'Saldo insuficiente del cliente para pago RKM' });
            }
            const commission = trip.platformcommission || 0;
            const driverNet = parseFloat((trip.price - commission).toFixed(2));
            const newClientBal = parseFloat((client.balance - trip.price).toFixed(2));
            await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newClientBal, trip.clientid]);
            const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]);
            if (conductor) {
                const newCondBal = parseFloat((conductor.balance + driverNet).toFixed(2));
                await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newCondBal, trip.conductorid]);
            }
            const rate = await getBCVRate();
            const amountBs = parseFloat((trip.price * rate).toFixed(2));
            await dbRun('INSERT INTO transactions (id, tripid, clientid, conductorid, amount, amountbs, method, status, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                ['TXN_' + Date.now(), req.params.id, trip.clientid, trip.conductorid, trip.price, amountBs, 'rkm', 'completado', now]);
            if (commission > 0) {
                await dbRun('INSERT INTO transactions (id, tripid, clientid, conductorid, amount, amountbs, method, status, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                    ['TXN_COM_' + Date.now(), req.params.id, null, trip.conductorid, commission, parseFloat((commission * rate).toFixed(2)), 'platform_commission', 'descontado', now]);
            }
            await dbRun('UPDATE trips SET status = $1, completedat = $2, paymentstatus = $3 WHERE id = $4', [status, now, 'pagado', req.params.id]);
            const updatedClient = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.clientid]));
            const updatedConductor = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]));
            io.to('client_' + trip.clientid).emit('user:updated', updatedClient);
            io.to('conductor_' + trip.conductorid).emit('user:updated', updatedConductor);
            io.emit('payment:completed', { tripId: req.params.id, method: 'rkm' });
        } else if (trip.paymentmethod === 'efectivo') {
            const commission = trip.platformcommission || 0;
            if (commission > 0) {
                const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]);
                if (conductor) {
                    const newCondBal = parseFloat((conductor.balance - commission).toFixed(2));
                    await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newCondBal, trip.conductorid]);
                }
                const rate = await getBCVRate();
                await dbRun('INSERT INTO transactions (id, tripid, clientid, conductorid, amount, amountbs, method, status, createdat) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
                    ['TXN_COM_' + Date.now(), req.params.id, null, trip.conductorid, commission, parseFloat((commission * rate).toFixed(2)), 'platform_commission', 'descontado', now]);
            }
            await dbRun('UPDATE trips SET status = $1, completedat = $2, paymentstatus = $3 WHERE id = $4', [status, now, 'pagado', req.params.id]);
            const updatedConductor = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]));
            io.to('conductor_' + trip.conductorid).emit('user:updated', updatedConductor);
        } else if (trip.paymentmethod === 'pago_movil') {
            await dbRun('UPDATE trips SET status = $1, completedat = $2 WHERE id = $3', ['pago_movil_pendiente', now, req.params.id]);
            io.emit('trip:status_changed', parseTrip(await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.id])));
        } else {
            await dbRun('UPDATE trips SET status = $1, completedat = $2 WHERE id = $3', [status, now, req.params.id]);
        }
    } else if (status === 'pago_verificado') {
        const isMudanzaPagoMovil = trip.paymentmethod === 'pago_movil' && trip.orderdetails;
        if (isMudanzaPagoMovil) {
            const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]);
            if (conductor) {
                const newCondBal = parseFloat((conductor.balance + trip.price).toFixed(2));
                await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newCondBal, trip.conductorid]);
            }
            await dbRun('UPDATE trips SET status = $1, paymentstatus = $2, paymentverifiedat = $3 WHERE id = $4', ['completado', 'pagado', now, req.params.id]);
            const updatedConductor = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]));
            io.to('conductor_' + trip.conductorid).emit('user:updated', updatedConductor);
        } else {
            await dbRun('UPDATE trips SET status = $1, paymentstatus = $2, paymentverifiedat = $3 WHERE id = $4', [status, 'pagado', now, req.params.id]);
        }
    } else if (status === 'aceptado') {
        if (trip.paymentmethod === 'efectivo' || trip.paymentmethod === 'rkm') {
            const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]);
            const isMudanza = trip.orderdetails && trip.orderdetails.subtype && MUDANZA_COMMISSION[trip.orderdetails.subtype];
            const commissionRate = isMudanza ? MUDANZA_COMMISSION[trip.orderdetails.subtype] : PLATFORM_COMMISSION_RATE;
            const commission = parseFloat((trip.price * commissionRate).toFixed(2));
            if (conductor && conductor.balance < commission) {
                return res.status(400).json({ error: `Saldo insuficiente. Necesitas $${commission.toFixed(2)} para la comision de Plataforma.` });
            }
        }
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

app.put('/api/trips/:id/rating', requireAuth, async (req, res) => {
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
app.get('/api/config', requireAuth, async (req, res) => res.json(await getConfig()));
app.get('/api/rkm-config', requireAuth, async (req, res) => res.json(await getConfig()));

app.put('/api/config', requireAdmin, async (req, res) => {
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
app.post('/api/payments/rkm', requireAuth, async (req, res) => {
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

app.post('/api/payments/pago_movil', requireAuth, async (req, res) => {
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
app.post('/api/wallet/recharge', requireAuth, async (req, res) => {
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

app.get('/api/wallet/recharges', requireAuth, async (req, res) => {
    const rows = await dbAll('SELECT * FROM recharges ORDER BY createdat DESC');
    res.json(rows.map(r => mapRow(r, RECHARGE_MAP)));
});

app.put('/api/wallet/recharges/:id', requireAdmin, async (req, res) => {
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
app.post('/api/wallet/withdraw', requireAuth, async (req, res) => {
    const { conductorId, amount } = req.body;
    const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [conductorId]);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    if (conductor.balance < amount) return res.status(400).json({ error: 'Saldo insuficiente' });
    const bankInfo = typeof conductor.bankinfo === 'string' ? JSON.parse(conductor.bankinfo || '{}') : (conductor.bankinfo || {});
    if (!bankInfo.bank || !bankInfo.account) return res.status(400).json({ error: 'Configura tu cuenta bancaria primero' });
    const vehicle = typeof conductor.vehicle === 'string' ? JSON.parse(conductor.vehicle || '{}') : (conductor.vehicle || {});
    const isMudanza = vehicle.type && (vehicle.type.startsWith('mudanza_') || vehicle.type === 'camioneta');
    const config = await getConfig();
    const commissionPct = isMudanza ? 0 : parseFloat(config.withdrawalCommission || '10');
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

app.get('/api/wallet/withdrawals', requireAuth, async (req, res) => {
    const rows = await dbAll('SELECT * FROM withdrawals ORDER BY createdat DESC');
    res.json(rows.map(r => mapRow(r, WITHDRAWAL_MAP)));
});

app.put('/api/wallet/withdrawals/:id', requireAdmin, async (req, res) => {
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

// === WITHDRAWAL PDF TICKET ===
app.get('/api/wallet/withdrawals/:id/ticket', requireAuth, async (req, res) => {
    const withdrawal = await dbGet('SELECT * FROM withdrawals WHERE id = $1', [req.params.id]);
    if (!withdrawal) return res.status(404).json({ error: 'Retiro no encontrado' });
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=ticket_retiro_${withdrawal.id}.pdf`);
    doc.pipe(res);
    const bankInfo = typeof withdrawal.bankinfo === 'string' ? JSON.parse(withdrawal.bankinfo || '{}') : (withdrawal.bankinfo || {});
    const bankNames = { '0102': 'Banco de Venezuela', '0104': 'Banco Provincial', '0105': 'Banco Mercantil', '0108': 'Banco BBVA', '0114': 'Banco Bancaribe', '0116': 'Banco Plaza', '0128': 'Banco Occidental', '0134': 'Banco Venezolano de Credito', '0151': 'Banco BFC', '0156': '100% Banco', '0157': 'Banco Del Tesoro', '0163': 'Banco Guerra', '0168': 'Bancrecer', '0169': 'Mi Banco', '0171': 'Banco del Pueblo Soberano', '0172': 'Bancamiga', '0173': 'Banco Internacional', '0174': 'Banplus', '0175': 'Bicentenario', '0177': 'Banco Facilito', '0185': 'Fondo Comun' };
    const bankName = bankNames[bankInfo.bank] || bankInfo.bank || '-';
    doc.fontSize(20).font('Helvetica-Bold').text('TuRides', { align: 'center' });
    doc.fontSize(14).font('Helvetica').text('Comprobante de Retiro', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).fillColor('#666');
    doc.text(`Fecha: ${withdrawal.createdat ? new Date(withdrawal.createdat).toLocaleString() : '-'}`, { align: 'left' });
    doc.text(`ID: ${withdrawal.id}`, { align: 'left' });
    doc.moveDown();
    doc.fontSize(12).fillColor('#000').font('Helvetica-Bold').text('Datos del Conductor');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Nombre: ${withdrawal.conductorname}`);
    doc.moveDown();
    doc.fontSize(12).font('Helvetica-Bold').text('Detalle del Retiro');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Monto solicitado: $${withdrawal.amount.toFixed(2)}`);
    doc.text(`Tasa BCV: Bs ${withdrawal.amountbs / withdrawal.amount}/USD`);
    doc.text(`Monto en Bs: Bs ${withdrawal.amountbs.toFixed(2)}`);
    doc.text(`Comision de retiro: $${withdrawal.commission.toFixed(2)} (${withdrawal.commission > 0 ? ((withdrawal.commission / withdrawal.amount) * 100).toFixed(0) + '%' : '0% - Mudanza'})`);
    doc.text(`Monto a transferir: $${withdrawal.netamount.toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(12).font('Helvetica-Bold').text('Datos Bancarios');
    doc.fontSize(10).font('Helvetica');
    doc.text(`Banco: ${bankName}`);
    doc.text(`Cuenta: ${bankInfo.account || '-'}`);
    doc.text(`Titular: ${bankInfo.name || '-'}`);
    doc.text(`Telefono: ${bankInfo.phone || '-'}`);
    doc.moveDown();
    doc.fontSize(10).fillColor('#999').text(`Estado: ${withdrawal.status.toUpperCase()}`);
    if (withdrawal.reference) {
        doc.text(`Referencia: ${withdrawal.reference}`);
    }
    if (withdrawal.reviewedat) {
        doc.text(`Procesado: ${new Date(withdrawal.reviewedat).toLocaleString()}`);
    }
    doc.moveDown(2);
    doc.fontSize(8).fillColor('#ccc').text('TuRides - Comprobante de retiro generado automaticamente', { align: 'center' });
    doc.end();
});

// === ADMIN DAILY REPORT ===
app.get('/api/admin/daily-report', requireAdmin, async (req, res) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const trips = await dbAll('SELECT * FROM trips WHERE createdat LIKE $1 ORDER BY createdat ASC', [date + '%']);
    const transactions = await dbAll('SELECT * FROM transactions WHERE createdat LIKE $1 ORDER BY createdat ASC', [date + '%']);
    const withdrawals = await dbAll('SELECT * FROM withdrawals WHERE createdat LIKE $1 ORDER BY createdat ASC', [date + '%']);
    const parsedTrips = trips.map(t => parseTrip(t));
    const byVehicleType = {};
    parsedTrips.forEach(t => {
        const vehicleType = t.conductorVehicle || 'N/A';
        let category = 'Otros';
        if (vehicleType.toLowerCase().includes('carro')) category = 'Carro';
        else if (vehicleType.toLowerCase().includes('camioneta') || vehicleType.toLowerCase().includes('mudanza') || vehicleType.toLowerCase().includes('pickup')) category = 'Camiones/Mudanza';
        else if (vehicleType.toLowerCase().includes('moto')) category = 'Motos';
        if (!byVehicleType[category]) byVehicleType[category] = { trips: [], totalVolume: 0, totalCommission: 0, count: 0 };
        byVehicleType[category].trips.push(t);
        byVehicleType[category].totalVolume += t.price;
        byVehicleType[category].totalCommission += (t.platformCommission || 0);
        byVehicleType[category].count++;
    });
    const totalVolume = parsedTrips.reduce((a, t) => a + t.price, 0);
    const totalCommission = parsedTrips.reduce((a, t) => a + (t.platformCommission || 0), 0);
    const completedTrips = parsedTrips.filter(t => ['completado', 'pago_verificado', 'calificado'].includes(t.status));
    const pendingPayments = parsedTrips.filter(t => t.status === 'pago_movil_pendiente');
    res.json({ date, totalTrips: parsedTrips.length, completedTrips: completedTrips.length, totalVolume, totalCommission, byVehicleType, pendingPayments: pendingPayments.length, transactions: transactions.map(t => mapRow(t, TXN_MAP)), withdrawals: withdrawals.map(w => mapRow(w, WITHDRAWAL_MAP)) });
});

// === TRANSACTIONS ===
app.get('/api/transactions', requireAdmin, async (req, res) => {
    const rows = await dbAll('SELECT * FROM transactions ORDER BY createdat DESC');
    res.json(rows.map(r => mapRow(r, TXN_MAP)));
});

// === ADMIN PAGO MOVIL MUDANZA VERIFICATION ===
app.put('/api/admin/verify-pago-movil/:tripId', requireAdmin, async (req, res) => {
    const trip = await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.tripId]);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    if (trip.paymentmethod !== 'pago_movil' || trip.status !== 'pago_movil_pendiente') {
        return res.status(400).json({ error: 'Este viaje no esta pendiente de verificacion' });
    }
    const now = new Date().toISOString();
    const conductor = await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]);
    if (conductor) {
        const newCondBal = parseFloat((conductor.balance + trip.price).toFixed(2));
        await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [newCondBal, trip.conductorid]);
    }
    await dbRun('UPDATE trips SET status = $1, paymentstatus = $2, paymentverifiedat = $3 WHERE id = $4', ['completado', 'pagado', now, req.params.tripId]);
    const updatedTrip = parseTrip(await dbGet('SELECT * FROM trips WHERE id = $1', [req.params.tripId]));
    const updatedConductor = parseUser(await dbGet('SELECT * FROM users WHERE id = $1', [trip.conductorid]));
    io.to('conductor_' + trip.conductorid).emit('user:updated', updatedConductor);
    io.to('client_' + trip.clientid).emit('trip:status_changed', updatedTrip);
    io.to('conductor_' + trip.conductorid).emit('trip:status_changed', updatedTrip);
    res.json(updatedTrip);
});

// === ADMIN RESET DATABASE ===
app.post('/api/admin/reset-db', requireAdmin, async (req, res) => {
    try {
        const { confirm } = req.body;
        if (confirm !== 'BORRAR_TODO') {
            return res.status(400).json({ error: 'Debes enviar confirm: "BORRAR_TODO"' });
        }
        await dbRun('DELETE FROM referrals');
        await dbRun('DELETE FROM pass_purchases');
        await dbRun('DELETE FROM withdrawals');
        await dbRun('DELETE FROM recharges');
        await dbRun('DELETE FROM transactions');
        await dbRun('DELETE FROM trips');
        await dbRun('DELETE FROM config');
        await dbRun('DELETE FROM users');
        res.json({ ok: true, message: 'Base de datos borrada completamente.' });
    } catch (err) {
        console.error('Reset DB error:', err);
        res.status(500).json({ error: 'Error al borrar la base de datos' });
    }
});

// === EMERGENCY RESET (no auth, secret code required) ===
app.post('/api/emergency-reset', async (req, res) => {
    try {
        const { code } = req.body;
        if (code !== 'turides-2026-reset') {
            return res.status(403).json({ error: 'Codigo invalido' });
        }
        await dbRun('DELETE FROM referrals');
        await dbRun('DELETE FROM pass_purchases');
        await dbRun('DELETE FROM withdrawals');
        await dbRun('DELETE FROM recharges');
        await dbRun('DELETE FROM transactions');
        await dbRun('DELETE FROM trips');
        await dbRun('DELETE FROM config');
        await dbRun('DELETE FROM users');
        res.json({ ok: true, message: 'Base de datos borrada. Ya puedes crear el admin.' });
    } catch (err) {
        console.error('Emergency reset error:', err);
        res.status(500).json({ error: 'Error al borrar la base de datos' });
    }
});

// === BACKUP & RESTORE ===
app.get('/api/admin/backup/status', requireAdmin, async (req, res) => {
    try {
        const row = await dbGet("SELECT value FROM config WHERE key = 'lastBackupAt'");
        const lastBackup = row ? row.value : null;
        const daysSince = lastBackup ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000) : null;
        res.json({ lastBackup, daysSince, needsBackup: daysSince === null || daysSince >= 7 });
    } catch (err) {
        res.json({ lastBackup: null, daysSince: null, needsBackup: true });
    }
});

app.post('/api/admin/backup/track', requireAdmin, async (req, res) => {
    try {
        await dbRun("INSERT INTO config (key, value) VALUES ('lastBackupAt', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [new Date().toISOString()]);
        res.json({ ok: true });
    } catch (err) {
        res.json({ ok: false });
    }
});

app.post('/api/admin/backup/google-drive', requireAdmin, async (req, res) => {
    try {
        const credsJson = process.env.GOOGLE_DRIVE_CREDENTIALS;
        if (!credsJson) return res.status(400).json({ error: 'Google Drive no configurado. Agrega GOOGLE_DRIVE_CREDENTIALS en las variables de entorno de Render.' });

        const { google } = require('googleapis');
        const creds = JSON.parse(credsJson);
        const auth = new google.auth.GoogleAuth({
            credentials: creds,
            scopes: ['https://www.googleapis.com/auth/drive.file']
        });
        const drive = google.drive({ version: 'v3', auth });

        const users = (await dbAll('SELECT * FROM users')).map(u => {
            const m = mapRow(u, USER_MAP);
            return { ...m, vehicle: m.vehicle ? JSON.parse(m.vehicle) : null, ratings: m.ratings ? JSON.parse(m.ratings) : [], bankInfo: m.bankInfo ? JSON.parse(m.bankInfo) : null };
        });
        const trips = (await dbAll('SELECT * FROM trips')).map(t => mapRow(t, TRIP_MAP));
        const transactions = (await dbAll('SELECT * FROM transactions')).map(tx => mapRow(tx, TXN_MAP));
        const config = (await dbAll('SELECT * FROM config'));
        const configObj = {};
        config.forEach(c => { configObj[c.key] = c.value; });
        const recharges = (await dbAll('SELECT * FROM recharges')).map(r => mapRow(r, RECHARGE_MAP));
        const withdrawals = (await dbAll('SELECT * FROM withdrawals')).map(w => mapRow(w, WITHDRAWAL_MAP));

        const backup = {
            version: '1.0',
            createdAt: new Date().toISOString(),
            data: { users, trips, transactions, config: configObj, recharges, withdrawals }
        };

        const fileName = `turides-backup-${new Date().toISOString().slice(0,10)}.json`;
        const fileMetadata = { name: fileName, mimeType: 'application/json' };
        const media = { mimeType: 'application/json', body: JSON.stringify(backup, null, 2) };

        const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || null;
        if (folderId) fileMetadata.parents = [folderId];

        const file = await drive.files.create({ resource: fileMetadata, media, fields: 'id, name' });

        await dbRun("INSERT INTO config (key, value) VALUES ('lastBackupAt', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [new Date().toISOString()]);

        res.json({ ok: true, fileId: file.data.id, fileName: file.data.name });
    } catch (err) {
        console.error('Google Drive backup error:', err);
        res.status(500).json({ error: 'Error al subir a Google Drive: ' + err.message });
    }
});

app.get('/api/admin/backup', requireAdmin, async (req, res) => {
    try {
        const users = (await dbAll('SELECT * FROM users')).map(u => {
            const m = mapRow(u, USER_MAP);
            return { ...m, vehicle: m.vehicle ? JSON.parse(m.vehicle) : null, ratings: m.ratings ? JSON.parse(m.ratings) : [], bankInfo: m.bankInfo ? JSON.parse(m.bankInfo) : null };
        });
        const trips = (await dbAll('SELECT * FROM trips')).map(t => mapRow(t, TRIP_MAP));
        const transactions = (await dbAll('SELECT * FROM transactions')).map(tx => mapRow(tx, TXN_MAP));
        const config = (await dbAll('SELECT * FROM config'));
        const configObj = {};
        config.forEach(c => { configObj[c.key] = c.value; });
        const recharges = (await dbAll('SELECT * FROM recharges')).map(r => mapRow(r, RECHARGE_MAP));
        const withdrawals = (await dbAll('SELECT * FROM withdrawals')).map(w => mapRow(w, WITHDRAWAL_MAP));

        const backup = {
            version: '1.0',
            createdAt: new Date().toISOString(),
            data: { users, trips, transactions, config: configObj, recharges, withdrawals }
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="turides-backup-${new Date().toISOString().slice(0,10)}.json"`);
        res.json(backup);
    } catch (err) {
        console.error('Backup error:', err);
        res.status(500).json({ error: 'Error al crear backup' });
    }
});

app.post('/api/admin/restore', requireAdmin, express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const backup = req.body;
        if (!backup || !backup.data) return res.status(400).json({ error: 'Formato de backup inválido' });

        const { users, trips, transactions, config, recharges, withdrawals } = backup.data;

        const { getPool } = require('./db');
        const pool = getPool();
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            if (users && users.length > 0) {
                for (const u of users) {
                    await client.query(`INSERT INTO users (id, name, phone, email, password, role, available, vehicle, tariffmode, fixedtariffs, balance, bankinfo, ratings, twofactorsecret, twofactorenabled, passwordchanged)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (id) DO UPDATE SET
                        name=$2, phone=$3, email=$4, password=$5, role=$6, available=$7, vehicle=$8, tariffmode=$9, fixedtariffs=$10, balance=$11, bankinfo=$12, ratings=$13, twofactorsecret=$14, twofactorenabled=$15, passwordchanged=$16`,
                        [u.id, u.name, u.phone, u.email, u.password, u.role, u.available ? 1 : 0,
                         u.vehicle ? JSON.stringify(u.vehicle) : null, u.tariffMode, u.fixedTariffs ? JSON.stringify(u.fixedTariffs) : null,
                         u.balance || 0, u.bankInfo ? JSON.stringify(u.bankInfo) : null,
                         JSON.stringify(u.ratings || []), u.twoFactorSecret, u.twoFactorEnabled ? 1 : 0, u.passwordChanged ? 1 : 0]);
                }
            }
            if (config && Object.keys(config).length > 0) {
                for (const [k, v] of Object.entries(config)) {
                    await client.query('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, v]);
                }
            }
            if (trips && trips.length > 0) {
                for (const t of trips) {
                    await client.query(`INSERT INTO trips (id, clientid, clientname, clientphone, originaddress, destinationaddress, distance, conductorid, conductorname, conductorphone, conductorvehicle, price, pricebs, paymentmethod, status, paymentstatus, clientrating, conductorrating, clientratingat, conductorratingat, createdat, completedat, paymentverifiedat, faremultiplier, fareperiod)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) ON CONFLICT (id) DO NOTHING`,
                        [t.id, t.clientId, t.clientName, t.clientPhone, t.originAddress, t.destinationAddress, t.distance,
                         t.conductorId, t.conductorName, t.conductorPhone, t.conductorVehicle,
                         t.price, t.priceBs, t.paymentMethod, t.status, t.paymentStatus,
                         t.clientRating, t.conductorRating, t.clientRatingAt, t.conductorRatingAt,
                         t.createdAt, t.completedAt, t.paymentVerifiedAt, t.fareMultiplier || 1.0, t.farePeriod || 'normal']);
                }
            }
            if (transactions && transactions.length > 0) {
                for (const tx of transactions) {
                    await client.query(`INSERT INTO transactions (id, tripid, clientid, conductorid, amount, amountbs, method, status, reference, phone, bankcode, createdat)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
                        [tx.id, tx.tripId, tx.clientId, tx.conductorId, tx.amount, tx.amountBs, tx.method, tx.status, tx.reference, tx.phone, tx.bankCode, tx.createdAt]);
                }
            }
            if (recharges && recharges.length > 0) {
                for (const r of recharges) {
                    await client.query(`INSERT INTO recharges (id, userid, username, amount, amountbs, phone, bankcode, reference, status, adminnote, createdat, reviewedat)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
                        [r.id, r.userId, r.username, r.amount, r.amountBs, r.phone, r.bankCode, r.reference, r.status, r.adminNote, r.createdAt, r.reviewedAt]);
                }
            }
            if (withdrawals && withdrawals.length > 0) {
                for (const w of withdrawals) {
                    await client.query(`INSERT INTO withdrawals (id, conductorid, conductorname, amount, amountbs, commission, netamount, bankinfo, status, adminnote, reference, createdat, reviewedat)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
                        [w.id, w.conductorId, w.conductorName, w.amount, w.amountBs, w.commission || 0, w.netAmount || 0,
                         w.bankInfo ? JSON.stringify(w.bankInfo) : null, w.status, w.adminNote, w.reference, w.createdAt, w.reviewedAt]);
                }
            }

            await client.query('COMMIT');
            res.json({ ok: true, message: 'Backup restaurado exitosamente', users: users?.length || 0, trips: trips?.length || 0 });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Restore error:', e);
            res.status(500).json({ error: 'Error al restaurar: ' + e.message });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Restore error:', err);
        res.status(500).json({ error: 'Error al restaurar backup' });
    }
});

// === PASS TuRides - Constants ===
const PASS_TIERS = {
    bronce:  { level: 1, cost: 10,  limit: 100, label: 'Bronce' },
    plata:   { level: 2, cost: 20,  limit: 250, label: 'Plata' },
    oro:     { level: 3, cost: 50,  limit: 700, label: 'Oro' }
};
const PASS_LEVELS = ['bronce', 'plata', 'oro'];
const REFERRAL_COMMISSION = 5;
const PASS_PURCHASES_TO_UNLOCK = 3;

async function getPassStatus(userId) {
    const purchases = await dbAll('SELECT * FROM pass_purchases WHERE userid = $1 ORDER BY createdat ASC', [userId]);
    const purchasesByLevel = { bronce: 0, plata: 0, oro: 0 };
    let currentLevel = 'bronce';
    let totalSpent = 0;
    purchases.forEach(p => {
        if (purchasesByLevel[p.passlevel] !== undefined) purchasesByLevel[p.passlevel]++;
        totalSpent += p.amount;
    });
    if (purchasesByLevel.oro >= PASS_PURCHASES_TO_UNLOCK) currentLevel = 'oro';
    else if (purchasesByLevel.plata >= PASS_PURCHASES_TO_UNLOCK) currentLevel = 'oro';
    else if (purchasesByLevel.plata > 0) currentLevel = 'plata';
    else if (purchasesByLevel.bronce >= PASS_PURCHASES_TO_UNLOCK) currentLevel = 'plata';
    else if (purchasesByLevel.bronce > 0) currentLevel = 'bronce';
    const nextLevel = currentLevel === 'oro' ? null : currentLevel === 'plata' ? 'oro' : 'plata';
    let purchasesInCurrentLevel = 0;
    if (currentLevel === 'bronce') purchasesInCurrentLevel = purchasesByLevel.bronce;
    else if (currentLevel === 'plata') purchasesInCurrentLevel = purchasesByLevel.plata;
    else purchasesInCurrentLevel = purchasesByLevel.oro;
    const progressToNext = nextLevel ? purchasesInCurrentLevel : PASS_PURCHASES_TO_UNLOCK;
    const referrals = await dbAll('SELECT * FROM referrals WHERE referrerid = $1 AND status = $2', [userId, 'efectivo']);
    const referralCredits = referrals.reduce((acc, r) => acc + (r.commission || REFERRAL_COMMISSION), 0);
    const lastPurchase = purchases.length > 0 ? purchases[purchases.length - 1] : null;
    let activePass = null;
    let earnedWithPass = 0;
    if (lastPurchase) {
        const tier = PASS_TIERS[lastPurchase.passlevel];
        const trips = await dbAll('SELECT price FROM trips WHERE conductorid = $1 AND status IN ($2,$3,$4) AND createdat >= $5', [userId, 'completado', 'pago_verificado', 'calificado', lastPurchase.createdat]);
        earnedWithPass = trips.reduce((acc, t) => acc + t.price, 0);
        if (earnedWithPass < tier.limit) {
            activePass = { level: lastPurchase.passlevel, label: tier.label, cost: tier.cost, limit: tier.limit, earned: earnedWithPass, remaining: tier.limit - earnedWithPass, purchasedAt: lastPurchase.createdat };
        }
    }
    return { currentLevel, nextLevel, purchasesByLevel, progressToNext, purchasesNeeded: nextLevel ? Math.max(0, PASS_PURCHASES_TO_UNLOCK - progressToNext) : 0, referralCredits, totalReferrals: referrals.length, activePass, totalSpent };
}

// GET - Estado PASS del conductor
app.get('/api/pass/status', requireAuth, async (req, res) => {
    try {
        const status = await getPassStatus(req.authUser.id);
        res.json(status);
    } catch (err) {
        console.error('Pass status error:', err);
        res.status(500).json({ error: 'Error al obtener estado PASS' });
    }
});

// POST - Comprar PASS
app.post('/api/pass/buy', requireAuth, async (req, res) => {
    try {
        const { passLevel, paymentMethod, creditApplied } = req.body;
        if (!PASS_TIERS[passLevel]) return res.status(400).json({ error: 'Nivel PASS invalido' });
        const tier = PASS_TIERS[passLevel];
        const status = await getPassStatus(req.authUser.id);
        const allowed = [];
        if (status.currentLevel === 'bronce') { allowed.push('bronce'); }
        else if (status.currentLevel === 'plata') { allowed.push('bronce', 'plata'); }
        else { allowed.push('bronce', 'plata', 'oro'); }
        if (!allowed.includes(passLevel)) return res.status(400).json({ error: `No puedes comprar PASS ${tier.label} desde tu nivel actual` });
        const credit = Math.min(creditApplied || 0, status.referralCredits, tier.cost);
        const finalAmount = parseFloat((tier.cost - credit).toFixed(2));
        if (paymentMethod === 'rkm') {
            const user = await dbGet('SELECT balance FROM users WHERE id = $1', [req.authUser.id]);
            if (user.balance < finalAmount) return res.status(400).json({ error: `Saldo insuficiente. Necesitas $${finalAmount.toFixed(2)} y tienes $${user.balance.toFixed(2)}` });
            await dbRun('UPDATE users SET balance = $1 WHERE id = $2', [parseFloat((user.balance - finalAmount).toFixed(2)), req.authUser.id]);
        }
        const id = 'PASS_' + Date.now();
        const now = new Date().toISOString();
        await dbRun('INSERT INTO pass_purchases (id, userid, username, passlevel, amount, creditapplied, paymentmethod, status, createdat) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [id, req.authUser.id, req.authUser.name || 'Conductor', passLevel, tier.cost, credit, paymentMethod || 'rkm', 'completado', now]);
        if (credit > 0) {
            const referrals = await dbAll('SELECT * FROM referrals WHERE referrerid = $1 AND status = $2 ORDER BY createdat ASC', [req.authUser.id, 'efectivo']);
            let remaining = credit;
            for (const r of referrals) {
                if (remaining <= 0) break;
                const deduct = Math.min(r.commission, remaining);
                const newComm = parseFloat((r.commission - deduct).toFixed(2));
                remaining = parseFloat((remaining - deduct).toFixed(2));
                if (newComm <= 0) {
                    await dbRun('DELETE FROM referrals WHERE id = $1', [r.id]);
                } else {
                    await dbRun('UPDATE referrals SET commission = $1 WHERE id = $2', [newComm, r.id]);
                }
            }
        }
        const newStatus = await getPassStatus(req.authUser.id);
        io.to('conductor_' + req.authUser.id).emit('pass:updated', newStatus);
        res.json({ success: true, message: `PASS ${tier.label} activado. Puedes generar hasta $${tier.limit} sin comisiones.`, pass: newStatus });
    } catch (err) {
        console.error('Pass buy error:', err);
        res.status(500).json({ error: 'Error al comprar PASS' });
    }
});

// GET - Referidos del conductor
app.get('/api/pass/referrals', requireAuth, async (req, res) => {
    try {
        const referrals = await dbAll('SELECT * FROM referrals WHERE referrerid = $1 ORDER BY createdat DESC', [req.authUser.id]);
        const mapped = referrals.map(r => ({ id: r.id, referrerId: r.referrerid, referrerName: r.referrername, referredId: r.referredid, referredName: r.referredname, referredEmail: r.referredemail, passAmount: r.passamount, commission: r.commission, status: r.status, createdAt: r.createdat }));
        res.json(mapped);
    } catch (err) {
        console.error('Referrals error:', err);
        res.status(500).json({ error: 'Error al obtener referidos' });
    }
});

// POST - Registrar referido (cuando un conductor/mensajero se registra con codigo)
app.post('/api/pass/referral/register', requireAuth, async (req, res) => {
    try {
        const { referredEmail, referredName } = req.body;
        if (!referredEmail || !referredName) return res.status(400).json({ error: 'Datos del referido incompletos' });
        const id = 'REF_' + Date.now();
        const now = new Date().toISOString();
        await dbRun('INSERT INTO referrals (id, referrerid, referrername, referredid, referredname, referredemail, passamount, commission, status, createdat) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
            [id, req.authUser.id, req.authUser.name || 'Conductor', '', referredName, referredEmail, 0, REFERRAL_COMMISSION, 'pendiente', now]);
        res.json({ success: true, message: 'Referido registrado. Se acreditara $5 cuando compre su primer PASS.' });
    } catch (err) {
        console.error('Referral register error:', err);
        res.status(500).json({ error: 'Error al registrar referido' });
    }
});

// PUT - Validar referido (admin confirma que compro PASS)
app.put('/api/pass/referrals/:id/validate', requireAdmin, async (req, res) => {
    try {
        const { status, passAmount } = req.body;
        const referral = await dbGet('SELECT * FROM referrals WHERE id = $1', [req.params.id]);
        if (!referral) return res.status(404).json({ error: 'Referido no encontrado' });
        const now = new Date().toISOString();
        if (status === 'efectivo') {
            await dbRun('UPDATE referrals SET status = $1, passamount = $2 WHERE id = $3', ['efectivo', passAmount || 10, req.params.id]);
        } else {
            await dbRun('UPDATE referrals SET status = $1 WHERE id = $2', [status, req.params.id]);
        }
        if (status === 'efectivo') {
            io.to('conductor_' + referral.referrerid).emit('referral:validated', { referralId: req.params.id, commission: REFERRAL_COMMISSION });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Referral validate error:', err);
        res.status(500).json({ error: 'Error al validar referido' });
    }
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
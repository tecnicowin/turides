const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

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

const DB_PATH = path.join(__dirname, 'turides.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT,
        email TEXT UNIQUE,
        password TEXT,
        role TEXT,
        available INTEGER DEFAULT 0,
        vehicle TEXT,
        tariffMode TEXT,
        fixedTariffs TEXT,
        balance REAL DEFAULT 0,
        bankInfo TEXT,
        ratings TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY,
        clientId TEXT,
        clientName TEXT,
        clientPhone TEXT,
        originAddress TEXT,
        destinationAddress TEXT,
        distance REAL,
        conductorId TEXT,
        conductorName TEXT,
        conductorPhone TEXT,
        conductorVehicle TEXT,
        price REAL,
        priceBs REAL,
        paymentMethod TEXT,
        status TEXT DEFAULT 'pendiente',
        paymentStatus TEXT,
        clientRating INTEGER,
        conductorRating INTEGER,
        clientRatingAt TEXT,
        conductorRatingAt TEXT,
        createdAt TEXT,
        completedAt TEXT,
        paymentVerifiedAt TEXT,
        fareMultiplier REAL DEFAULT 1.0,
        farePeriod TEXT DEFAULT 'normal'
    );
    CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        tripId TEXT,
        clientId TEXT,
        conductorId TEXT,
        amount REAL,
        amountBs REAL,
        method TEXT,
        status TEXT,
        reference TEXT,
        phone TEXT,
        bankCode TEXT,
        createdAt TEXT
    );
    CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS recharges (
        id TEXT PRIMARY KEY,
        userId TEXT,
        userName TEXT,
        amount REAL,
        amountBs REAL,
        phone TEXT,
        bankCode TEXT,
        reference TEXT,
        status TEXT DEFAULT 'pendiente',
        adminNote TEXT,
        createdAt TEXT,
        reviewedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS withdrawals (
        id TEXT PRIMARY KEY,
        conductorId TEXT,
        conductorName TEXT,
        amount REAL,
        amountBs REAL,
        bankInfo TEXT,
        status TEXT DEFAULT 'pendiente',
        adminNote TEXT,
        createdAt TEXT,
        reviewedAt TEXT
    );
`);

const SEED_USERS = [
    { id: 'admin@turides.com', name: 'Administrador TuRides', email: 'admin@turides.com', password: '123', role: 'admin', balance: 0, ratings: '[]', bankInfo: '{}' },
    { id: 'cliente1@gmail.com', name: 'Carlos Mendoza', phone: '0412-5551234', email: 'cliente1@gmail.com', password: '123', role: 'cliente', balance: 250.00, ratings: '[]', bankInfo: '{}' },
    { id: 'cliente2@gmail.com', name: 'Ana Gomez', phone: '0424-9998877', email: 'cliente2@gmail.com', password: '123', role: 'cliente', balance: 300.00, ratings: '[]', bankInfo: '{}' },
    { id: 'conductor1@turides.com', name: 'Pedro Infante', phone: '0414-1112233', email: 'conductor1@turides.com', password: '123', role: 'conductor', available: 1, vehicle: JSON.stringify({ type: 'carro', brand: 'Toyota', model: 'Corolla 2018', passengers: 4, suitcases: 3 }), tariffMode: 'fijo', fixedTariffs: JSON.stringify({ defaultPrice: 35.00 }), balance: 45.00, ratings: JSON.stringify([5, 4, 5, 5, 4]), bankInfo: JSON.stringify({ bank: '0102', account: '0102-1234-5678-9012', phone: '0414-1112233', name: 'Pedro Infante' }) },
    { id: 'conductor3@turides.com', name: 'Maria Gabriela', phone: '0424-7773322', email: 'conductor3@turides.com', password: '123', role: 'conductor', available: 1, vehicle: JSON.stringify({ type: 'carro', brand: 'Ford', model: 'Explorer SUV 2020', passengers: 6, suitcases: 5 }), tariffMode: 'fijo', fixedTariffs: JSON.stringify({ defaultPrice: 55.00 }), balance: 150.00, ratings: JSON.stringify([5, 5, 4, 5, 5, 5]), bankInfo: JSON.stringify({ bank: '0105', account: '0105-9876-5432-1098', phone: '0424-7773322', name: 'Maria Gabriela' }) },
    { id: 'conductor2@turides.com', name: 'Juan Herrera', phone: '0416-4445566', email: 'conductor2@turides.com', password: '123', role: 'conductor', available: 1, vehicle: JSON.stringify({ type: 'carro', brand: 'Chevrolet', model: 'Aveo 2015', passengers: 4, suitcases: 2 }), tariffMode: 'kilometros', fixedTariffs: '{}', balance: 80.00, ratings: JSON.stringify([4, 3, 4, 5, 3]), bankInfo: JSON.stringify({ bank: '0108', account: '0108-5555-6666-7777', phone: '0416-4445566', name: 'Juan Herrera' }) },
    { id: 'conductor4@turides.com', name: 'Carlos Prueba', phone: '0412-9998877', email: 'conductor4@turides.com', password: '123', role: 'conductor', available: 1, vehicle: JSON.stringify({ type: 'carro', brand: 'Hyundai', model: 'Accent 2022', passengers: 4, suitcases: 3 }), tariffMode: 'fijo', fixedTariffs: JSON.stringify({ defaultPrice: 25.00 }), balance: 0.00, ratings: '[]', bankInfo: JSON.stringify({ bank: '0134', account: '0134-1111-2222-3333', phone: '0412-9998877', name: 'Carlos Prueba' }) },
    { id: 'conductor5@turides.com', name: 'Luis Motero', phone: '0412-5551122', email: 'conductor5@turides.com', password: '123', role: 'conductor', available: 1, vehicle: JSON.stringify({ type: 'moto', brand: 'Yamaha', model: 'MT-07 2023', passengers: 1, suitcases: 0 }), tariffMode: 'kilometros', fixedTariffs: '{}', balance: 30.00, ratings: JSON.stringify([5, 5, 4]), bankInfo: JSON.stringify({ bank: '0172', account: '0172-4444-5555-6666', phone: '0412-5551122', name: 'Luis Motero' }) },
    { id: 'conductor6@turides.com', name: 'Maria Moto', phone: '0424-3334455', email: 'conductor6@turides.com', password: '123', role: 'conductor', available: 1, vehicle: JSON.stringify({ type: 'moto', brand: 'Honda', model: 'CB190R 2022', passengers: 1, suitcases: 0 }), tariffMode: 'fijo', fixedTariffs: JSON.stringify({ defaultPrice: 15.00 }), balance: 20.00, ratings: JSON.stringify([4, 5, 4, 5]), bankInfo: JSON.stringify({ bank: '0174', account: '0174-7777-8888-9999', phone: '0424-3334455', name: 'Maria Moto' }) }
];

const SEED_CONFIG = {
    bankName: 'Banco de Venezuela',
    accountNumber: '0102-0000-0000-0000-0000',
    accountType: 'Ahorro',
    documentType: 'V',
    documentNumber: '00000000',
    phone: '0412-0000000',
    holderName: 'TuRides C.A.',
    bcvRate: '36.50',
    bcvLastUpdate: new Date().toISOString()
};

function seedDB() {
    const migrations = [
        `ALTER TABLE users ADD COLUMN bankInfo TEXT DEFAULT '{}'`,
        `ALTER TABLE trips ADD COLUMN priceBs REAL DEFAULT 0`,
        `ALTER TABLE trips ADD COLUMN fareMultiplier REAL DEFAULT 1.0`,
        `ALTER TABLE trips ADD COLUMN farePeriod TEXT DEFAULT 'normal'`,
        `ALTER TABLE transactions ADD COLUMN amountBs REAL DEFAULT 0`
    ];
    for (const sql of migrations) {
        try { db.exec(sql); } catch(e) { /* column already exists */ }
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (count === 0) {
        const insertUser = db.prepare('INSERT INTO users (id, name, phone, email, password, role, available, vehicle, tariffMode, fixedTariffs, balance, ratings, bankInfo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const insertMany = db.transaction((users) => {
            for (const u of users) {
                insertUser.run(u.id, u.name, u.phone || null, u.email, u.password, u.role, u.available || 0, u.vehicle || null, u.tariffMode || null, u.fixedTariffs || null, u.balance || 0, u.ratings || '[]', u.bankInfo || '{}');
            }
        });
        insertMany(SEED_USERS);
        const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
        for (const [k, v] of Object.entries(SEED_CONFIG)) {
            insertConfig.run(k, v);
        }
        console.log('Database seeded.');
    }
}
seedDB();

function parseUser(row) {
    if (!row) return null;
    const { password, ...safe } = row;
    safe.available = !!safe.available;
    if (safe.vehicle) safe.vehicle = JSON.parse(safe.vehicle);
    if (safe.fixedTariffs) safe.fixedTariffs = JSON.parse(safe.fixedTariffs);
    if (safe.ratings) safe.ratings = JSON.parse(safe.ratings);
    if (safe.bankInfo) { try { safe.bankInfo = JSON.parse(safe.bankInfo); } catch(e) { safe.bankInfo = {}; } }
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

function getConfig() {
    const rows = db.prepare('SELECT * FROM config').all();
    const config = {};
    rows.forEach(r => { config[r.key] = r.value; });
    return config;
}

function getBCVRate() {
    const config = getConfig();
    return parseFloat(config.bcvRate) || 36.50;
}

function toBs(usd) {
    return parseFloat((usd * getBCVRate()).toFixed(2));
}

function getFarePeriod() {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeVal = hour + minute / 60;

    if (timeVal >= 17 && timeVal < 20) {
        return { period: 'pico', multiplier: 1.25 };
    }
    if (timeVal >= 22 || timeVal < 5) {
        return { period: 'noche', multiplier: 1.20 };
    }
    return { period: 'normal', multiplier: 1.0 };
}

const KILOMETER_RATE = {
    carro: { base: 1.80, perKm: 0.50, minDistance: 2.5 },
    moto: { base: 0.80, perKm: 0.20, minDistance: 2.5 }
};

// === AUTH ===
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const row = db.prepare('SELECT * FROM users WHERE email = ? AND password = ?').get(email.toLowerCase(), password);
    if (!row) return res.status(401).json({ error: 'Credenciales incorrectas' });
    res.json(parseUser(row));
});

app.post('/api/register', (req, res) => {
    const { name, phone, email, password, role, vehicleData } = req.body;
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (exists) return res.status(400).json({ error: 'El correo ya esta registrado' });
    const vehicle = role === 'conductor' && vehicleData ? JSON.stringify({ type: vehicleData.type || 'carro', brand: vehicleData.brand, model: vehicleData.model, passengers: parseInt(vehicleData.passengers) || 4, suitcases: parseInt(vehicleData.suitcases) || 2 }) : null;
    const tariffMode = role === 'conductor' ? (vehicleData?.tariffMode || 'kilometros') : null;
    const fixedTariffs = role === 'conductor' ? JSON.stringify({ defaultPrice: 20.00 }) : null;
    db.prepare('INSERT INTO users (id, name, phone, email, password, role, available, vehicle, tariffMode, fixedTariffs, balance, ratings, bankInfo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)').run(email, name, phone, email.toLowerCase(), password, role, 0, vehicle, tariffMode, fixedTariffs, '[]', '{}');
    const user = parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(email));
    io.emit('user:created', user);
    res.json(user);
});

// === USERS ===
app.get('/api/users', (req, res) => {
    const rows = db.prepare('SELECT * FROM users').all();
    res.json(rows.map(parseUser));
});

app.get('/api/users/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(parseUser(row));
});

app.put('/api/users/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Usuario no encontrado' });
    const updates = req.body;
    if (updates.vehicle && typeof updates.vehicle === 'object') updates.vehicle = JSON.stringify(updates.vehicle);
    if (updates.fixedTariffs && typeof updates.fixedTariffs === 'object') updates.fixedTariffs = JSON.stringify(updates.fixedTariffs);
    if (updates.ratings && Array.isArray(updates.ratings)) updates.ratings = JSON.stringify(updates.ratings);
    if (updates.bankInfo && typeof updates.bankInfo === 'object') updates.bankInfo = JSON.stringify(updates.bankInfo);
    if (updates.available !== undefined) updates.available = updates.available ? 1 : 0;
    const fields = Object.keys(updates).filter(k => k !== 'id' && k !== 'password');
    if (fields.length === 0) return res.json(parseUser(row));
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => updates[f]);
    db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...values, req.params.id);
    const updated = parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id));
    io.emit('user:updated', updated);
    res.json(updated);
});

// === AVAILABLE CONDUCTORS ===
app.get('/api/conductors/available', (req, res) => {
    const distance = parseFloat(req.query.distance) || 10;
    const vehicleType = req.query.vehicleType || 'carro';
    const rows = db.prepare('SELECT * FROM users WHERE role = ? AND available = 1').all('conductor');
    const fareInfo = getFarePeriod();
    const conductors = rows.filter(c => {
        const v = JSON.parse(c.vehicle || '{}');
        return v.type === vehicleType;
    }).map(c => {
        const vehicle = JSON.parse(c.vehicle || '{}');
        const fixedTariffs = JSON.parse(c.fixedTariffs || '{}');
        const ratings = JSON.parse(c.ratings || '[]');
        let price = 0;
        const rates = KILOMETER_RATE[vehicle.type] || KILOMETER_RATE.carro;
        if (c.tariffMode === 'fijo') {
            price = parseFloat(fixedTariffs.defaultPrice) || 35.00;
        } else {
            price = rates.base;
            if (distance > rates.minDistance) {
                price += (distance - rates.minDistance) * rates.perKm;
            }
        }
        price = parseFloat((price * fareInfo.multiplier).toFixed(2));
        const avgRating = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : null;
        return { ...parseUser(c), calculatedPrice: price, calculatedPriceBs: toBs(price), avgRating, ratingCount: ratings.length, farePeriod: fareInfo.period, fareMultiplier: fareInfo.multiplier };
    });
    res.json(conductors);
});

// === TRIPS ===
app.get('/api/trips', (req, res) => {
    const rows = db.prepare('SELECT * FROM trips ORDER BY createdAt DESC').all();
    res.json(rows.map(parseTrip));
});

app.post('/api/trips', (req, res) => {
    const { clientId, clientName, clientPhone, originAddress, destinationAddress, distance, conductorId, price, paymentMethod } = req.body;
    const conductor = db.prepare('SELECT * FROM users WHERE id = ?').get(conductorId);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    const vehicle = JSON.parse(conductor.vehicle || '{}');
    const id = 'TRIP_' + Date.now();
    const now = new Date().toISOString();
    const fareInfo = getFarePeriod();
    const finalPrice = parseFloat((price * fareInfo.multiplier).toFixed(2));
    const priceBs = toBs(finalPrice);
    db.prepare('INSERT INTO trips (id, clientId, clientName, clientPhone, originAddress, destinationAddress, distance, conductorId, conductorName, conductorPhone, conductorVehicle, price, priceBs, paymentMethod, status, createdAt, fareMultiplier, farePeriod) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, clientId, clientName, clientPhone, originAddress, destinationAddress, parseFloat(distance), conductorId, conductor.name, conductor.phone, `${vehicle.brand} ${vehicle.model}`, finalPrice, priceBs, paymentMethod, 'pendiente', now, fareInfo.multiplier, fareInfo.period);
    const trip = parseTrip(db.prepare('SELECT * FROM trips WHERE id = ?').get(id));
    io.emit('trip:created', trip);
    io.to('conductor_' + conductorId).emit('trip:new_request', trip);
    res.json(trip);
});

app.put('/api/trips/:id/status', (req, res) => {
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { status } = req.body;
    const now = new Date().toISOString();
    if (status === 'completado') {
        db.prepare('UPDATE trips SET status = ?, completedAt = ? WHERE id = ?').run(status, now, req.params.id);
    } else if (status === 'pago_verificado') {
        db.prepare('UPDATE trips SET status = ?, paymentVerifiedAt = ? WHERE id = ?').run(status, now, req.params.id);
    } else if (status === 'aceptado') {
        db.prepare('UPDATE trips SET status = ? WHERE id = ?').run(status, req.params.id);
        db.prepare('UPDATE users SET available = 0 WHERE id = ?').run(trip.conductorId);
    } else if (status === 'calificado') {
        db.prepare('UPDATE trips SET status = ? WHERE id = ?').run(status, req.params.id);
        db.prepare('UPDATE users SET available = 1 WHERE id = ?').run(trip.conductorId);
    } else {
        db.prepare('UPDATE trips SET status = ? WHERE id = ?').run(status, req.params.id);
    }
    const updated = parseTrip(db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id));
    io.emit('trip:status_changed', updated);
    io.to('client_' + updated.clientId).emit('trip:status_changed', updated);
    io.to('conductor_' + updated.conductorId).emit('trip:status_changed', updated);
    res.json(updated);
});

app.put('/api/trips/:id/rating', (req, res) => {
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { field, value } = req.body;
    const now = new Date().toISOString();
    db.prepare(`UPDATE trips SET ${field} = ?, ${field}At = ? WHERE id = ?`).run(value, now, req.params.id);
    const userField = field === 'clientRating' ? 'clientId' : 'conductorId';
    const userId = trip[userField];
    const user = db.prepare('SELECT ratings FROM users WHERE id = ?').get(userId);
    if (user) {
        const ratings = JSON.parse(user.ratings || '[]');
        ratings.push(value);
        db.prepare('UPDATE users SET ratings = ? WHERE id = ?').run(JSON.stringify(ratings), userId);
    }
    const updatedTrip = db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id);
    if (updatedTrip.clientRating && updatedTrip.conductorRating) {
        db.prepare('UPDATE trips SET status = ? WHERE id = ?').run('calificado', req.params.id);
        db.prepare('UPDATE users SET available = 1 WHERE id = ?').run(updatedTrip.conductorId);
    }
    const final = parseTrip(db.prepare('SELECT * FROM trips WHERE id = ?').get(req.params.id));
    io.emit('trip:rated', final);
    io.to('client_' + final.clientId).emit('trip:rated', final);
    io.to('conductor_' + final.conductorId).emit('trip:rated', final);
    res.json(final);
});

// === CONFIG / BCV RATE ===
app.get('/api/config', (req, res) => {
    res.json(getConfig());
});

app.get('/api/rkm-config', (req, res) => {
    res.json(getConfig());
});

app.put('/api/config', (req, res) => {
    const updates = req.body;
    const upsert = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(updates)) {
        upsert.run(k, String(v));
    }
    io.emit('config:updated', getConfig());
    res.json(getConfig());
});

// === FARE INFO ===
app.get('/api/fare-info', (req, res) => {
    const fareInfo = getFarePeriod();
    const config = getConfig();
    res.json({
        ...fareInfo,
        bcvRate: parseFloat(config.bcvRate) || 36.50,
        rates: KILOMETER_RATE,
        bcvLastUpdate: config.bcvLastUpdate || null
    });
});

// === PAYMENTS ===
app.post('/api/payments/rkm', (req, res) => {
    const { tripId } = req.body;
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const client = db.prepare('SELECT * FROM users WHERE id = ?').get(trip.clientId);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (client.balance < trip.price) return res.status(400).json({ error: 'Saldo insuficiente' });
    const newClientBalance = parseFloat((client.balance - trip.price).toFixed(2));
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newClientBalance, trip.clientId);
    const conductor = db.prepare('SELECT * FROM users WHERE id = ?').get(trip.conductorId);
    if (conductor) {
        const newCondBalance = parseFloat((conductor.balance + trip.price).toFixed(2));
        db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newCondBalance, trip.conductorId);
    }
    const now = new Date().toISOString();
    const amountBs = toBs(trip.price);
    db.prepare('INSERT INTO transactions (id, tripId, clientId, conductorId, amount, amountBs, method, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('TXN_' + Date.now(), tripId, trip.clientId, trip.conductorId, trip.price, amountBs, 'rkm', 'completado', now);
    db.prepare('UPDATE trips SET paymentStatus = ?, status = ?, completedAt = ? WHERE id = ?').run('pagado', 'completado', now, tripId);
    io.emit('payment:completed', { tripId, method: 'rkm' });
    const updatedClient = parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(trip.clientId));
    const updatedConductor = parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(trip.conductorId));
    io.to('client_' + trip.clientId).emit('user:updated', updatedClient);
    io.to('conductor_' + trip.conductorId).emit('user:updated', updatedConductor);
    res.json({ success: true });
});

app.post('/api/payments/pago_movil', (req, res) => {
    const { tripId, phone, bankCode, reference } = req.body;
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
    if (!trip) return res.status(404).json({ error: 'Viaje no encontrado' });
    const now = new Date().toISOString();
    const amountBs = toBs(trip.price);
    db.prepare('INSERT INTO transactions (id, tripId, clientId, conductorId, amount, amountBs, method, status, reference, phone, bankCode, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('TXN_' + Date.now(), tripId, trip.clientId, trip.conductorId, trip.price, amountBs, 'pago_movil', 'completado', reference, phone, bankCode, now);
    db.prepare('UPDATE trips SET paymentStatus = ?, status = ?, completedAt = ? WHERE id = ?').run('pagado', 'completado', now, tripId);
    io.emit('payment:completed', { tripId, method: 'pago_movil' });
    res.json({ success: true });
});

// === WALLET RECHARGE (Client) ===
app.post('/api/wallet/recharge', (req, res) => {
    const { userId, amount, phone, bankCode, reference } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    const id = 'RCH_' + Date.now();
    const now = new Date().toISOString();
    const amountBs = toBs(amount);
    db.prepare('INSERT INTO recharges (id, userId, userName, amount, amountBs, phone, bankCode, reference, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, userId, user.name, amount, amountBs, phone, bankCode, reference, 'pendiente', now);
    io.emit('recharge:created', { id, userId, userName: user.name, amount, amountBs, status: 'pendiente' });
    res.json({ success: true, id, message: 'Solicitud de recarga enviada. Pendiente de aprobacion por administrador.' });
});

app.get('/api/wallet/recharges', (req, res) => {
    const rows = db.prepare('SELECT * FROM recharges ORDER BY createdAt DESC').all();
    res.json(rows);
});

app.put('/api/wallet/recharges/:id', (req, res) => {
    const { status, adminNote } = req.body;
    const recharge = db.prepare('SELECT * FROM recharges WHERE id = ?').get(req.params.id);
    if (!recharge) return res.status(404).json({ error: 'Recarga no encontrada' });
    const now = new Date().toISOString();
    db.prepare('UPDATE recharges SET status = ?, adminNote = ?, reviewedAt = ? WHERE id = ?').run(status, adminNote || '', now, req.params.id);
    if (status === 'aprobada') {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(recharge.userId);
        if (user) {
            const newBalance = parseFloat((user.balance + recharge.amount).toFixed(2));
            db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, recharge.userId);
            const updated = parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(recharge.userId));
            io.to('client_' + recharge.userId).emit('user:updated', updated);
            io.to('client_' + recharge.userId).emit('recharge:approved', { amount: recharge.amount });
        }
    }
    io.emit('recharge:updated', { id: req.params.id, status });
    res.json({ success: true });
});

// === WALLET WITHDRAWAL (Conductor) ===
app.post('/api/wallet/withdraw', (req, res) => {
    const { conductorId, amount } = req.body;
    const conductor = db.prepare('SELECT * FROM users WHERE id = ?').get(conductorId);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
    if (conductor.balance < amount) return res.status(400).json({ error: 'Saldo insuficiente en billetera' });
    const bankInfo = JSON.parse(conductor.bankInfo || '{}');
    if (!bankInfo.bank || !bankInfo.account) return res.status(400).json({ error: 'Debes configurar tu cuenta bancaria en Configuracion primero' });
    const id = 'WDR_' + Date.now();
    const now = new Date().toISOString();
    const amountBs = toBs(amount);
    db.prepare('INSERT INTO withdrawals (id, conductorId, conductorName, amount, amountBs, bankInfo, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, conductorId, conductor.name, amount, amountBs, JSON.stringify(bankInfo), 'pendiente', now);
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(parseFloat((conductor.balance - amount).toFixed(2)), conductorId);
    const updated = parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(conductorId));
    io.to('conductor_' + conductorId).emit('user:updated', updated);
    io.emit('withdrawal:created', { id, conductorId, conductorName: conductor.name, amount, amountBs, status: 'pendiente' });
    res.json({ success: true, id, message: 'Solicitud de retiro enviada. Pendiente de aprobacion por administrador.' });
});

app.get('/api/wallet/withdrawals', (req, res) => {
    const rows = db.prepare('SELECT * FROM withdrawals ORDER BY createdAt DESC').all();
    res.json(rows);
});

app.put('/api/wallet/withdrawals/:id', (req, res) => {
    const { status, adminNote } = req.body;
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
    if (!withdrawal) return res.status(404).json({ error: 'Retiro no encontrado' });
    const now = new Date().toISOString();
    db.prepare('UPDATE withdrawals SET status = ?, adminNote = ?, reviewedAt = ? WHERE id = ?').run(status, adminNote || '', now, req.params.id);
    if (status === 'rechazada') {
        const conductor = db.prepare('SELECT * FROM users WHERE id = ?').get(withdrawal.conductorId);
        if (conductor) {
            const newBalance = parseFloat((conductor.balance + withdrawal.amount).toFixed(2));
            db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, withdrawal.conductorId);
            const updated = parseUser(db.prepare('SELECT * FROM users WHERE id = ?').get(withdrawal.conductorId));
            io.to('conductor_' + withdrawal.conductorId).emit('user:updated', updated);
            io.to('conductor_' + withdrawal.conductorId).emit('withdrawal:rejected', { amount: withdrawal.amount, reason: adminNote });
        }
    } else if (status === 'aprobada') {
        io.to('conductor_' + withdrawal.conductorId).emit('withdrawal:approved', { amount: withdrawal.amount });
    }
    io.emit('withdrawal:updated', { id: req.params.id, status });
    res.json({ success: true });
});

// === TRANSACTIONS ===
app.get('/api/transactions', (req, res) => {
    const rows = db.prepare('SELECT * FROM transactions ORDER BY createdAt DESC').all();
    res.json(rows);
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    socket.on('join', (room) => { socket.join(room); });
    socket.on('disconnect', () => { console.log('Disconnected:', socket.id); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`TuRides server running on http://localhost:${PORT}`);
});

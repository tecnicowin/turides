const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
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

const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const seed = {
            users: [
                { id: 'admin@turides.com', name: 'Administrador TuRides', email: 'admin@turides.com', password: '123', role: 'admin', balance: 0, ratings: [] },
                { id: 'cliente1@gmail.com', name: 'Carlos Mendoza', phone: '0412-5551234', email: 'cliente1@gmail.com', password: '123', role: 'cliente', balance: 250.00, ratings: [] },
                { id: 'cliente2@gmail.com', name: 'Ana Gomez', phone: '0424-9998877', email: 'cliente2@gmail.com', password: '123', role: 'cliente', balance: 300.00, ratings: [] },
                { id: 'conductor1@turides.com', name: 'Pedro Infante', phone: '0414-1112233', email: 'conductor1@turides.com', password: '123', role: 'conductor', available: true, vehicle: { type: 'carro', brand: 'Toyota', model: 'Corolla 2018', passengers: 4, suitcases: 3 }, tariffMode: 'fijo', fixedTariffs: { defaultPrice: 35.00 }, balance: 45.00, ratings: [5, 4, 5, 5, 4] },
                { id: 'conductor3@turides.com', name: 'Maria Gabriela', phone: '0424-7773322', email: 'conductor3@turides.com', password: '123', role: 'conductor', available: true, vehicle: { type: 'carro', brand: 'Ford', model: 'Explorer SUV 2020', passengers: 6, suitcases: 5 }, tariffMode: 'fijo', fixedTariffs: { defaultPrice: 55.00 }, balance: 150.00, ratings: [5, 5, 4, 5, 5, 5] },
                { id: 'conductor2@turides.com', name: 'Juan Herrera', phone: '0416-4445566', email: 'conductor2@turides.com', password: '123', role: 'conductor', available: true, vehicle: { type: 'carro', brand: 'Chevrolet', model: 'Aveo 2015', passengers: 4, suitcases: 2 }, tariffMode: 'kilometros', fixedTariffs: {}, balance: 80.00, ratings: [4, 3, 4, 5, 3] },
                { id: 'conductor4@turides.com', name: 'Carlos Prueba', phone: '0412-9998877', email: 'conductor4@turides.com', password: '123', role: 'conductor', available: true, vehicle: { type: 'carro', brand: 'Hyundai', model: 'Accent 2022', passengers: 4, suitcases: 3 }, tariffMode: 'fijo', fixedTariffs: { defaultPrice: 25.00 }, balance: 0.00, ratings: [] },
                { id: 'conductor5@turides.com', name: 'Luis Motero', phone: '0412-5551122', email: 'conductor5@turides.com', password: '123', role: 'conductor', available: true, vehicle: { type: 'moto', brand: 'Yamaha', model: 'MT-07 2023', passengers: 1, suitcases: 0 }, tariffMode: 'kilometros', fixedTariffs: {}, balance: 30.00, ratings: [5, 5, 4] },
                { id: 'conductor6@turides.com', name: 'Maria Moto', phone: '0424-3334455', email: 'conductor6@turides.com', password: '123', role: 'conductor', available: true, vehicle: { type: 'moto', brand: 'Honda', model: 'CB190R 2022', passengers: 1, suitcases: 0 }, tariffMode: 'fijo', fixedTariffs: { defaultPrice: 15.00 }, balance: 20.00, ratings: [4, 5, 4, 5] }
            ],
            trips: [],
            transactions: [],
            rkmConfig: {
                bankName: 'Banco de Venezuela',
                accountNumber: '0102-0000-0000-0000-0000',
                accountType: 'Ahorro',
                documentType: 'V',
                documentNumber: '00000000',
                phone: '0412-0000000',
                holderName: 'TuRides C.A.',
                exchangeRate: 36.50
            }
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
        return seed;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const KILOMETER_RATE = {
    carro: { base: 4.00, perKm: 0.95, minDistance: 2.5 },
    moto: { base: 2.00, perKm: 0.50, minDistance: 2.0 }
};

// === AUTH ===
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const { password: _, ...safeUser } = user;
    res.json(safeUser);
});

app.post('/api/register', (req, res) => {
    const { name, phone, email, password, role, vehicleData } = req.body;
    const db = loadDB();
    if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
        return res.status(400).json({ error: 'El correo ya esta registrado' });
    }
    const newUser = { id: email, name, phone, email, password, role, balance: 0, ratings: [] };
    if (role === 'conductor' && vehicleData) {
        newUser.available = false;
        newUser.vehicle = { type: vehicleData.type || 'carro', brand: vehicleData.brand, model: vehicleData.model, passengers: parseInt(vehicleData.passengers) || 4, suitcases: parseInt(vehicleData.suitcases) || 2 };
        newUser.tariffMode = vehicleData.tariffMode || 'kilometros';
        newUser.fixedTariffs = { defaultPrice: 20.00 };
    }
    db.users.push(newUser);
    saveDB(db);
    const { password: _, ...safeUser } = newUser;
    io.emit('user:created', safeUser);
    res.json(safeUser);
});

// === USERS ===
app.get('/api/users', (req, res) => {
    const db = loadDB();
    const safe = db.users.map(({ password, ...u }) => u);
    res.json(safe);
});

app.get('/api/users/:id', (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const { password, ...safeUser } = user;
    res.json(safeUser);
});

app.put('/api/users/:id', (req, res) => {
    const db = loadDB();
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
    Object.assign(db.users[idx], req.body);
    saveDB(db);
    const { password, ...safeUser } = db.users[idx];
    io.emit('user:updated', safeUser);
    res.json(safeUser);
});

// === AVAILABLE CONDUCTORS ===
app.get('/api/conductors/available', (req, res) => {
    const db = loadDB();
    const distance = parseFloat(req.query.distance) || 10;
    const vehicleType = req.query.vehicleType || 'carro';
    const conductors = db.users.filter(u => u.role === 'conductor' && u.available === true && u.vehicle?.type === vehicleType).map(c => {
        let price = 0;
        const rates = KILOMETER_RATE[c.vehicle.type] || KILOMETER_RATE.carro;
        if (c.tariffMode === 'fijo') {
            price = parseFloat(c.fixedTariffs.defaultPrice) || 35.00;
        } else {
            price = rates.base;
            if (distance > rates.minDistance) {
                price += (distance - rates.minDistance) * rates.perKm;
            }
        }
        const avgRating = c.ratings && c.ratings.length > 0 ? (c.ratings.reduce((a, b) => a + b, 0) / c.ratings.length).toFixed(1) : null;
        return { ...c, calculatedPrice: parseFloat(price.toFixed(2)), avgRating, ratingCount: c.ratings?.length || 0 };
    });
    res.json(conductors);
});

// === TRIPS ===
app.get('/api/trips', (req, res) => {
    const db = loadDB();
    res.json(db.trips);
});

app.post('/api/trips', (req, res) => {
    const db = loadDB();
    const { clientId, clientName, clientPhone, originAddress, destinationAddress, distance, conductorId, price, paymentMethod } = req.body;
    const conductor = db.users.find(u => u.id === conductorId);
    if (!conductor) return res.status(404).json({ error: 'Conductor no encontrado' });
    const newTrip = {
        id: 'TRIP_' + Date.now(),
        clientId, clientName, clientPhone,
        originAddress, destinationAddress, distance: parseFloat(distance),
        conductorId: conductor.id, conductorName: conductor.name, conductorPhone: conductor.phone,
        conductorVehicle: `${conductor.vehicle.brand} ${conductor.vehicle.model}`,
        price: parseFloat(price), paymentMethod,
        status: 'pendiente',
        createdAt: new Date().toISOString()
    };
    db.trips.push(newTrip);
    saveDB(db);
    io.emit('trip:created', newTrip);
    io.to('conductor_' + conductorId).emit('trip:new_request', newTrip);
    res.json(newTrip);
});

app.put('/api/trips/:id/status', (req, res) => {
    const db = loadDB();
    const idx = db.trips.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { status } = req.body;
    db.trips[idx].status = status;
    if (status === 'completado') db.trips[idx].completedAt = new Date().toISOString();
    if (status === 'pago_verificado') db.trips[idx].paymentVerifiedAt = new Date().toISOString();
    if (status === 'calificado') {
        db.trips[idx].status = 'calificado';
        const condIdx = db.users.findIndex(u => u.id === db.trips[idx].conductorId);
        if (condIdx !== -1) db.users[condIdx].available = true;
    }
    if (status === 'aceptado') {
        const condIdx = db.users.findIndex(u => u.id === db.trips[idx].conductorId);
        if (condIdx !== -1) db.users[condIdx].available = false;
    }
    saveDB(db);
    const trip = db.trips[idx];
    io.emit('trip:status_changed', trip);
    io.to('client_' + trip.clientId).emit('trip:status_changed', trip);
    io.to('conductor_' + trip.conductorId).emit('trip:status_changed', trip);
    res.json(trip);
});

app.put('/api/trips/:id/rating', (req, res) => {
    const db = loadDB();
    const idx = db.trips.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Viaje no encontrado' });
    const { field, value } = req.body;
    db.trips[idx][field] = value;
    db.trips[idx][field + 'At'] = new Date().toISOString();

    const userField = field === 'clientRating' ? 'clientId' : 'conductorId';
    const userId = db.trips[idx][userField];
    const userIdx = db.users.findIndex(u => u.id === userId);
    if (userIdx !== -1) {
        if (!db.users[userIdx].ratings) db.users[userIdx].ratings = [];
        db.users[userIdx].ratings.push(value);
    }

    const bothRated = db.trips[idx].clientRating && db.trips[idx].conductorRating;
    if (bothRated) {
        db.trips[idx].status = 'calificado';
        const condIdx = db.users.findIndex(u => u.id === db.trips[idx].conductorId);
        if (condIdx !== -1) db.users[condIdx].available = true;
    }
    saveDB(db);
    const trip = db.trips[idx];
    io.emit('trip:rated', trip);
    io.to('client_' + trip.clientId).emit('trip:rated', trip);
    io.to('conductor_' + trip.conductorId).emit('trip:rated', trip);
    res.json(trip);
});

// === PAYMENTS ===
app.get('/api/rkm-config', (req, res) => {
    const db = loadDB();
    res.json(db.rkmConfig);
});

app.post('/api/payments/rkm', (req, res) => {
    const db = loadDB();
    const { tripId } = req.body;
    const tripIdx = db.trips.findIndex(t => t.id === tripId);
    if (tripIdx === -1) return res.status(404).json({ error: 'Viaje no encontrado' });
    const trip = db.trips[tripIdx];
    const clientIdx = db.users.findIndex(u => u.id === trip.clientId);
    if (clientIdx === -1) return res.status(404).json({ error: 'Cliente no encontrado' });
    if (db.users[clientIdx].balance < trip.price) return res.status(400).json({ error: 'Saldo insuficiente' });
    db.users[clientIdx].balance = parseFloat((db.users[clientIdx].balance - trip.price).toFixed(2));
    const condIdx = db.users.findIndex(u => u.id === trip.conductorId);
    if (condIdx !== -1) db.users[condIdx].balance = parseFloat((db.users[condIdx].balance + trip.price).toFixed(2));
    db.transactions.push({ id: 'TXN_' + Date.now(), tripId, clientId: trip.clientId, conductorId: trip.conductorId, amount: trip.price, method: 'rkm', status: 'completado', createdAt: new Date().toISOString() });
    trip.paymentStatus = 'pagado';
    trip.status = 'completado';
    trip.completedAt = new Date().toISOString();
    saveDB(db);
    io.emit('payment:completed', { tripId, method: 'rkm' });
    io.to('client_' + trip.clientId).emit('user:updated', { ...db.users[clientIdx], password: undefined });
    io.to('conductor_' + trip.conductorId).emit('user:updated', { ...db.users[condIdx], password: undefined });
    res.json({ success: true });
});

app.post('/api/payments/pago_movil', (req, res) => {
    const db = loadDB();
    const { tripId, phone, bankCode, reference } = req.body;
    const tripIdx = db.trips.findIndex(t => t.id === tripId);
    if (tripIdx === -1) return res.status(404).json({ error: 'Viaje no encontrado' });
    const trip = db.trips[tripIdx];
    db.transactions.push({ id: 'TXN_' + Date.now(), tripId, clientId: trip.clientId, conductorId: trip.conductorId, amount: trip.price, method: 'pago_movil', status: 'completado', reference, phone, bankCode, createdAt: new Date().toISOString() });
    trip.paymentStatus = 'pagado';
    trip.status = 'completado';
    trip.completedAt = new Date().toISOString();
    saveDB(db);
    io.emit('payment:completed', { tripId, method: 'pago_movil' });
    res.json({ success: true });
});

app.post('/api/rkm/recharge', (req, res) => {
    const db = loadDB();
    const { userId, amount } = req.body;
    const idx = db.users.findIndex(u => u.id === userId);
    if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado' });
    db.users[idx].balance = parseFloat((db.users[idx].balance + amount).toFixed(2));
    saveDB(db);
    const { password, ...safeUser } = db.users[idx];
    io.to('client_' + userId).emit('user:updated', safeUser);
    res.json(safeUser);
});

// === TRANSACTIONS ===
app.get('/api/transactions', (req, res) => {
    const db = loadDB();
    res.json(db.transactions);
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
    console.log('Connected:', socket.id);

    socket.on('join', (room) => {
        socket.join(room);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`TuRides server running on http://localhost:${PORT}`);
});

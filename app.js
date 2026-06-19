const socket = io();

const KILOMETER_RATE_CONFIG = { carro: { base: 1.80, perKm: 0.50, minDistance: 2.5 }, camioneta: { base: 4.50, perKm: 0.90, minDistance: 2.5 }, moto: { base: 0.80, perKm: 0.40, minDistance: 2.5 }, moto_delivery: { base: 1.80, perKm: 0.55, minDistance: 2.5 },     mensajero: { base: 0.50, perKm: 1.00, minDistance: 0.3, maxDistance: 3.0 }, mudanza: { flatRate: true }, mudanza_pickup: { base: 50, perKm: 0, flatRate: true }, mudanza_350: { base: 100, perKm: 0, flatRate: true }, mudanza_750: { base: 180, perKm: 0, flatRate: true } };

const API = {
    _headers() {
        const h = { 'Content-Type': 'application/json' };
        const session = App.session;
        if (session && session.id) h['x-user-id'] = session.id;
        return h;
    },
    async get(url) { const r = await fetch(url, { headers: this._headers() }); return r.json(); },
    async post(url, data) { const r = await fetch(url, { method: 'POST', headers: this._headers(), body: JSON.stringify(data) }); return r.json(); },
    async put(url, data) { const r = await fetch(url, { method: 'PUT', headers: this._headers(), body: JSON.stringify(data) }); return r.json(); }
};

const BANKS = [
    { code: '0102', name: 'Banco de Venezuela' },
    { code: '0104', name: 'Venezolano de Credito' },
    { code: '0105', name: 'Mercantil Banco' },
    { code: '0108', name: 'BBVA Provincial' },
    { code: '0114', name: 'Bancaribe' },
    { code: '0115', name: 'Banco Exterior' },
    { code: '0128', name: 'Banco Caroni' },
    { code: '0134', name: 'Banesco' },
    { code: '0137', name: 'Banco Sofitasa' },
    { code: '0138', name: 'Banco Plaza' },
    { code: '0146', name: 'Bangente' },
    { code: '0151', name: 'BFC Banco Fondo Comun' },
    { code: '0156', name: '100% Banco' },
    { code: '0157', name: 'DelSur Banco Universal' },
    { code: '0163', name: 'Banco del Tesoro' },
    { code: '0166', name: 'Banco Agricola de Venezuela' },
    { code: '0168', name: 'Bancrecer' },
    { code: '0169', name: 'R4 Banco Microfinanciero' },
    { code: '0171', name: 'Banco Activo' },
    { code: '0172', name: 'Bancamiga' },
    { code: '0173', name: 'Banco Internacional' },
    { code: '0174', name: 'Banplus' },
    { code: '0175', name: 'Banco Digital de Los Trabajadores' },
    { code: '0177', name: 'Banco de la Fuerza Armada' },
    { code: '0178', name: 'N58 Banco Digital' },
    { code: '0191', name: 'Banco Nacional de Credito' }
];
const BANK_NAMES_MAP = Object.fromEntries(BANKS.map(b => [b.code, b.name]));

const PASS_TIERS_CONFIG = {
    bronce:  { level: 1, cost: 10,  limit: 100, label: 'Bronce', icon: '🥉' },
    plata:   { level: 2, cost: 20,  limit: 250, label: 'Plata', icon: '🥈' },
    oro:     { level: 3, cost: 50,  limit: 700, label: 'Oro', icon: '🥇' }
};

const App = {
    session: null,
    activeView: 'login',
    calculatedDistance: 0.0,
    foundConductors: [],
    _lastKnownTripStatus: {},
    _pollingInterval: null,
    _pendingTripId: null,
    _pendingTripPrice: 0,
    _pendingConductorId: null,
    _selectedPaymentMethod: 'rkm',
    _pendingTimerInterval: null,
    _pendingTimerEnd: null,
    _conductorPollingInterval: null,
    _TRIP_TIMEOUT_MS: 180000,
    _bcvRate: 36.50,
    _fareInfo: { period: 'normal', multiplier: 1.0 },
    _setupStatus: null,
    _twoFactorPending: false,
    _twoFactorUserId: null,
    _twoFactorQR: null,
    _twoFactorSecret: null,

    async geocodeAddress(address) {
        try {
            const encoded = encodeURIComponent(address + ', Venezuela');
            const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`, {
                headers: { 'Accept-Language': 'es' }
            });
            const data = await r.json();
            if (data && data.length > 0) {
                return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
            }
        } catch(e) {}
        return null;
    },

    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },

    async calculateDistance(origin, dest) {
        const [originCoords, destCoords] = await Promise.all([
            this.geocodeAddress(origin),
            this.geocodeAddress(dest)
        ]);
        if (originCoords && destCoords) {
            const straightLine = this.haversineDistance(originCoords.lat, originCoords.lon, destCoords.lat, destCoords.lon);
            const roadFactor = 1.35;
            return parseFloat((straightLine * roadFactor).toFixed(1));
        }
        return null;
    },

    async init() {
        this._setupStatus = await API.get('/api/setup/status');
        const savedSession = localStorage.getItem('turides_session');
        if (savedSession) {
            try {
                const parsed = JSON.parse(savedSession);
                this.session = { id: parsed.id };
                const fresh = await API.get(`/api/users/${parsed.id}`);
                if (fresh && !fresh.error) {
                    this.session = fresh;
                } else {
                    this.session = null;
                    localStorage.removeItem('turides_session');
                }
            } catch(e) {
                this.session = null;
                localStorage.removeItem('turides_session');
            }
        }
        await this.loadFareInfo();
        this.setupEventListeners();
        this.setupSocketListeners();
        this.route();
    },

    async loadFareInfo() {
        try {
            const info = await API.get('/api/fare-info');
            this._bcvRate = info.bcvRate || 36.50;
            this._fareInfo = { period: info.period, multiplier: info.multiplier };
        } catch(e) {}
    },

    toBs(usd) {
        return (usd * this._bcvRate).toFixed(2);
    },

    formatPrice(usd) {
        return `$${usd.toFixed(2)} <span class="text-xs text-gray">/ Bs ${this.toBs(usd)}</span>`;
    },

    formatPriceText(usd) {
        return `$${usd.toFixed(2)} (Bs ${this.toBs(usd)})`;
    },

    setupSocketListeners() {
        socket.on('connect', () => {
            if (this.session) {
                const room = (this.session.role === 'conductor' || this.session.role === 'mensajero') ? 'conductor_' + this.session.id : this.session.role + '_' + this.session.id;
                socket.emit('join', room);
            }
        });

        socket.on('trip:new_request', (trip) => {
            if (this.session && (this.session.role === 'conductor' || this.session.role === 'mensajero') && trip.conductorId === this.session.id) {
                this.showToast('Nueva solicitud de viaje recibida!', 'info');
                this.updateViewContent();
            }
        });

        socket.on('trip:status_changed', (trip) => {
            if (!this.session) return;
            if (this.session.role === 'cliente' && trip.clientId === this.session.id) {
                if (trip.status === 'aceptado') {
                    this.stopPendingTimer();
                    this.showAcceptanceOverlay(trip);
                } else if (trip.status === 'rechazado') {
                    this.stopPendingTimer();
                    this.showToast('El conductor ha rechazado tu solicitud.', 'warning');
                }
                this.updateViewContent();
                this.renderNavbar();
            }
            if ((this.session.role === 'conductor' || this.session.role === 'mensajero') && trip.conductorId === this.session.id) {
                this.updateViewContent();
            }
        });

        socket.on('trip:rated', (trip) => {
            if (!this.session) return;
            if (this.session.id === trip.clientId || this.session.id === trip.conductorId) {
                this.updateViewContent();
                this.renderNavbar();
            }
        });

        socket.on('payment:completed', (data) => {
            if (!this.session) return;
            this.updateViewContent();
            this.renderNavbar();
        });

        socket.on('withdrawal:realized', (data) => {
            if (!this.session) return;
            this.showToast(`✅ Retiro realizado! Recibiste $${data.netAmount.toFixed(2)} en tu cuenta. Ref: ${data.reference}`, 'success');
            this.updateViewContent();
        });

        socket.on('withdrawal:created', (data) => {
            if (!this.session) return;
            if (this.session.role === 'admin') {
                this.showToast(`📤 Nuevo retiro de $${data.amount.toFixed(2)} solicitado por ${data.conductorName}`, 'warning');
                this.renderAdminDashboard();
            }
        });

        socket.on('withdrawal:rejected', (data) => {
            if (!this.session) return;
            this.showToast(`❌ Retiro rechazado: $${data.amount.toFixed(2)}. ${data.reason || ''}`, 'error');
            this.updateViewContent();
        });

        socket.on('user:updated', (user) => {
            if (!this.session) return;
            if (user.id === this.session.id) {
                this.session = user;
                localStorage.setItem('turides_session', JSON.stringify(user));
                this.renderNavbar();
                this.updateViewContent();
            }
        });

        socket.on('config:updated', (config) => {
            this._bcvRate = parseFloat(config.bcvRate) || 36.50;
            this.updateViewContent();
            this.renderNavbar();
        });

        socket.on('pass:approved', (data) => {
            if (!this.session) return;
            this.showToast(`PASS ${data.passLevel} aprobado! Ya esta activo.`, 'success');
            this.updateViewContent();
        });

        socket.on('pass:rejected', (data) => {
            if (!this.session) return;
            this.showToast(`PASS ${data.passLevel} rechazado. Contacta al admin.`, 'error');
            this.updateViewContent();
        });

        socket.on('pass:warning', (data) => {
            if (!this.session) return;
            this.showToast(`⚠️ Tu PASS esta al ${data.level}%. ${data.message}`, 'warning');
            this.updateViewContent();
        });

        socket.on('recharge:approved', (data) => {
            if (!this.session) return;
            this.showToast(`Recarga de $${data.amount.toFixed(2)} aprobada!`, 'success');
            this.refreshSession();
        });

        socket.on('withdrawal:rejected', (data) => {
            if (!this.session) return;
            this.showToast(`Retiro rechazado: $${data.amount.toFixed(2)} - ${data.reason || 'Sin motivo'}`, 'warning');
            this.refreshSession();
        });

        socket.on('withdrawal:approved', (data) => {
            if (!this.session) return;
            this.showToast(`Retiro de $${data.amount.toFixed(2)} aprobado!`, 'success');
            this.refreshSession();
        });

        socket.on('reconnect', () => {
            if (this.session) {
                const room = (this.session.role === 'conductor' || this.session.role === 'mensajero') ? 'conductor_' + this.session.id : this.session.role + '_' + this.session.id;
                socket.emit('join', room);
                this.updateViewContent();
            }
        });

        socket.on('recharge:created', (data) => {
            if (!this.session) return;
            if (this.session.role === 'admin') {
                this.showToast(`📥 Nueva solicitud de recarga de $${data.amount.toFixed(2)} por ${data.userName}`, 'warning');
                this.renderAdminDashboard();
            }
        });

        socket.on('recharge:updated', (data) => {
            if (!this.session) return;
            if (this.session.role === 'admin') {
                this.renderAdminDashboard();
            }
        });

        socket.on('reconnect', () => {
            if (this.session) {
                const room = (this.session.role === 'conductor' || this.session.role === 'mensajero') ? 'conductor_' + this.session.id : this.session.role + '_' + this.session.id;
                socket.emit('join', room);
                this.updateViewContent();
            }
        });
    },

    async refreshSession() {
        if (!this.session) return;
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.renderNavbar();
        this.updateViewContent();
    },

    startConductorPolling() {
        this.stopConductorPolling();
        this._conductorPollingInterval = setInterval(async () => {
            if (!this.session || this.session.role !== 'conductor') return;
            const prev = this._lastKnownTripStatus;
            try {
                const trips = await API.get('/api/trips');
                const activeTrip = trips.find(t => t.conductorId === this.session.id && ['pendiente', 'aceptado', 'completado', 'pago_verificado'].includes(t.status));
                if (activeTrip && activeTrip.status === 'pendiente' && prev[activeTrip.id] !== 'pendiente') {
                    this.showToast('Nueva solicitud de viaje recibida!', 'info');
                    this.updateViewContent();
                }
                if (activeTrip) this._lastKnownTripStatus[activeTrip.id] = activeTrip.status;
            } catch (e) {}
        }, 3000);
    },

    stopConductorPolling() { if (this._conductorPollingInterval) { clearInterval(this._conductorPollingInterval); this._conductorPollingInterval = null; } },

    route() {
        if (!this.session) {
            this.stopConductorPolling();
            if (this._setupStatus && !this._setupStatus.hasAdmin) {
                this.showView('setup');
            } else {
                this.showView('login');
            }
        } else {
            const room = (this.session.role === 'conductor' || this.session.role === 'mensajero') ? 'conductor_' + this.session.id : this.session.role + '_' + this.session.id;
            socket.emit('join', room);
            if (this.session.role === 'conductor' || this.session.role === 'mensajero') this.startConductorPolling();
            else this.stopConductorPolling();
            this.showView(this.session.role);
        }
    },

    showView(viewName) {
        this.activeView = viewName;
        document.querySelectorAll('.app-view').forEach(v => v.style.display = 'none');
        const target = document.getElementById(`view-${viewName}`);
        if (target) target.style.display = 'block';
        this.renderNavbar();
        if (viewName === 'help') { this.renderHelp(); return; }
        this.updateViewContent();
    },

    renderNavbar() {
        const nav = document.getElementById('main-nav');
        if (!this.session) { nav.style.display = 'none'; return; }
        nav.style.display = 'flex';
        document.getElementById('nav-user-name').textContent = this.session.name;
        document.getElementById('nav-user-role').textContent = this.session.role.toUpperCase();
        const balanceSpan = document.getElementById('nav-user-balance');
        const rkmSpan = document.getElementById('nav-rkm-balance');
        if (this.session.role === 'cliente') {
            balanceSpan.style.display = 'none';
            rkmSpan.classList.remove('hidden');
            rkmSpan.style.display = 'inline-flex';
            document.getElementById('nav-rkm-amount').textContent = `$${this.session.balance.toFixed(2)}`;
            document.getElementById('nav-rkm-amount-bs').textContent = `Bs ${this.toBs(this.session.balance)}`;
        } else if (this.session.role === 'conductor') {
            balanceSpan.style.display = 'inline-block';
            balanceSpan.innerHTML = `Billetera: <strong class="text-emerald">$${this.session.balance.toFixed(2)}</strong> <span class="text-xs text-gray">(Bs ${this.toBs(this.session.balance)})</span>`;
            rkmSpan.classList.add('hidden');
            rkmSpan.style.display = 'none';
        } else {
            balanceSpan.style.display = 'none';
            rkmSpan.classList.add('hidden');
            rkmSpan.style.display = 'none';
        }

        const fareLabel = document.getElementById('nav-fare-indicator');
        if (fareLabel) {
            const labels = { normal: 'Tarifa Normal', pico: 'Hora Pico +25%', noche: 'Noche +20%' };
            const colors = { normal: 'text-emerald', pico: 'text-red', noche: 'text-cyan' };
            fareLabel.textContent = labels[this._fareInfo.period] || 'Tarifa Normal';
            fareLabel.className = `badge text-xs ${colors[this._fareInfo.period] || 'text-emerald'}`;
        }

        const footerBcv = document.getElementById('footer-bcv-rate');
        if (footerBcv) footerBcv.textContent = this._bcvRate;
    },

    async updateViewContent() {
        if (!this.session) return;
        await this.loadFareInfo();
        switch (this.session.role) {
            case 'cliente': await this.renderClienteDashboard(); break;
            case 'conductor': await this.renderConductorDashboard(); break;
            case 'mensajero': await this.renderMensajeroDashboard(); break;
            case 'admin': await this.renderAdminDashboard(); break;
        }
    },

    renderHelp() {
        const c = document.getElementById('help-content');
        if (!c) return;
        const role = this.session ? this.session.role : 'all';
        c.innerHTML = `
<style>
    .help-body h3 { color: #10b981; margin: 20px 0 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px; }
    .help-body h4 { color: #60a5fa; margin: 12px 0 4px; }
    .help-body ul { margin: 4px 0 12px 20px; }
    .help-body li { margin: 3px 0; line-height: 1.5; }
    .help-body table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
    .help-body th, .help-body td { padding: 6px 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 0.85rem; }
    .help-body th { color: #60a5fa; font-weight: 600; }
    .help-body .help-tip { background: rgba(16,185,129,0.1); border-left: 3px solid #10b981; padding: 8px 12px; margin: 8px 0; border-radius: 4px; font-size: 0.85rem; }
    .help-body .help-warn { background: rgba(251,191,36,0.1); border-left: 3px solid #f59e0b; padding: 8px 12px; margin: 8px 0; border-radius: 4px; font-size: 0.85rem; }
</style>

<h3>1. Bienvenido a TuRides</h3>
<p>TuRides es una plataforma de transporte privado de pasajeros en Venezuela. Puedes solicitar viajes en <strong>Carro</strong>, <strong>Camioneta</strong>, <strong>Moto</strong> o <strong>Moto Delivery</strong>, pagar con billetera digital (RKM) o Pago Movil, y calificar a tu conductor o cliente.</p>

<h3>2. Cuentas y Acceso</h3>
<h4>Registro</h4>
<ul>
    <li>Crea tu cuenta con nombre, telefono, email y contrasena</li>
    <li>Selecciona tu rol: <strong>Cliente</strong> o <strong>Conductor</strong></li>
    <li>Los conductores deben registrar los datos de su vehiculo</li>
</ul>
<h4>Inicio de Sesion</h4>
<ul>
    <li>Ingresa con tu email y contrasena</li>
    <li>Si tienes <strong>2FA activado</strong>, se pedira el codigo de tu app de autenticacion (Google Authenticator o Authy)</li>
</ul>
<div class="help-tip">💡 Puedes cambiar tu contrasena desde cualquier pantalla en la seccion de Seguridad.</div>

<h3>3. Tarifas y Precios</h3>
<table>
    <tr><th>Vehiculo</th><th>Tarifa Base</th><th>Por Kilometro</th><th>Distancia</th></tr>
    <tr><td>🏍️ Moto</td><td>$0.80</td><td>$0.40/km</td><td>Min 2.5 km</td></tr>
    <tr><td>🛵 Moto Delivery</td><td>$1.80</td><td>$0.55/km</td><td>Min 2.5 km</td></tr>
    <tr><td>🚗 Carro</td><td>$1.80</td><td>$0.50/km</td><td>Min 2.5 km</td></tr>
    <tr><td>🚙 Camioneta</td><td>$4.50</td><td>$0.90/km</td><td>Min 2.5 km</td></tr>
    <tr><td>🚶 Mensajero</td><td>$1.50</td><td>$1.00/km</td><td>Max 2 km</td></tr>
    <tr><td>🚚 Mudanza Pick-Up</td><td>$50</td><td>Fijo</td><td>1 ton</td></tr>
    <tr><td>🚛 Mudanza 350</td><td>$100</td><td>Fijo</td><td>3.5 ton</td></tr>
    <tr><td>🚚 Mudanza 750</td><td>$180</td><td>Fijo</td><td>7 ton</td></tr>
</table>
<h4>Recargos por Horario</h4>
<table>
    <tr><th>Periodo</th><th>Horario</th><th>Recargo</th></tr>
    <tr><td>Normal</td><td>5:00 AM - 4:59 PM</td><td>Sin recargo</td></tr>
    <tr><td>Hora Pico</td><td>5:00 PM - 7:59 PM</td><td>+25%</td></tr>
    <tr><td>Noche</td><td>10:00 PM - 4:59 AM</td><td>+20%</td></tr>
</table>
<div class="help-tip">💡 El precio se calcula automaticamente: Base + (Km excedentes x Tarifa/Km) x Multiplicador del horario.</div>

<h3>4. Metodos de Pago</h3>
<h4>💰 Billetera TuRides (RKM)</h4>
<ul>
    <li>Pago instantaneo: se descuenta de tu saldo al completar el viaje</li>
    <li>El conductor recibe el dinero al instante en su billetera</li>
    <li>Recarga tu saldo enviando un Pago Movil a la cuenta de TuRides y subiendo el comprobante</li>
    <li>El admin aprueba la recarga y tu saldo se actualiza</li>
</ul>
<h4>📱 Pago Movil</h4>
<ul>
    <li>Transferencia bancaria directa al conductor</li>
    <li>Al finalizar el viaje, ingresa: banco, telefono y referencia</li>
    <li>El conductor verifica el pago en persona</li>
</ul>
<div class="help-warn">⚠️ El saldo de la billetera se maneja en dolares. La tasa BCV se actualiza diariamente por el admin.</div>

<h3>5. Flujo de un Viaje</h3>
<h4>Para Clientes:</h4>
<ol>
    <li>Selecciona tipo de vehiculo (Carro, Camioneta, Moto, Moto Delivery o Mensajero)</li>
    <li>Ingresa origen y destino</li>
    <li>Revisa conductores disponibles con precio estimado</li>
    <li>Selecciona metodo de pago y confirma</li>
    <li>Espera que el conductor acepte</li>
    <li>Al llegar, califica al conductor (1-5 estrellas)</li>
</ol>
<h4>Para Conductores:</h4>
<ol>
    <li>Activa tu disponibilidad</li>
    <li>Recibe solicitudes de clientes</li>
    <li>Acepta o rechaza el viaje</li>
    <li>Lleva al cliente al destino</li>
    <li>Marca "Completar Viaje" - el pago RKM se procesa automatico</li>
    <li>Califica al cliente (1-5 estrellas)</li>
</ol>

<h3>6. Estados del Viaje</h3>
<table>
    <tr><th>Estado</th><th>Significado</th></tr>
    <tr><td>pendiente</td><td>Solicitud enviada, esperando conductor</td></tr>
    <tr><td>aceptado</td><td>Conductor acepto, viaje en curso</td></tr>
    <tr><td>completado</td><td>Viaje finalizado, pago procesado</td></tr>
    <tr><td>pago_verificado</td><td>Conductor confirmo recibir el pago</td></tr>
    <tr><td>calificado</td><td>Ambos se calificaron, viaje cerrado</td></tr>
    <tr><td>rechazado</td><td>Conductor rechazo la solicitud</td></tr>
</table>

<h3>7. Billetera y Retiros</h3>
<h4>Recargar Saldo (Clientes)</h4>
<ul>
    <li>Ve a tu billetera y haz clic en "+ Recargar"</li>
    <li>Envia el Pago Movil a la cuenta de TuRides</li>
    <li>Ingresa los datos: banco, telefono, referencia y monto</li>
    <li>El admin revisa y aprueba tu recarga</li>
</ul>
<h4>Retirar Saldo (Conductores)</h4>
<ul>
    <li>Configura tu cuenta bancaria en la billetera</li>
    <li>Solicita un retiro indicando el monto</li>
    <li>Se aplica una comision configurable (default 10%)</li>
    <li>El admin procesa la transferencia y confirma con referencia</li>
</ul>
<div class="help-tip">💡 Tu saldo se actualiza en tiempo real. Cada pago o recarga se refleja al instante.</div>

<h3>8. Seguridad - 2FA</h3>
<ul>
    <li>Activa la autenticacion de dos factores desde tu perfil</li>
    <li>Escanea el QR con Google Authenticator o Authy</li>
    <li>Ingresa el codigo de 6 digitos para confirmar</li>
    <li>Cada vez que inicies sesion, se pedira el codigo</li>
    <li>Puedes desactivar 2FA en cualquier momento (requiere contrasena)</li>
</ul>

<h3>9. Calificaciones</h3>
<ul>
    <li>Al finalizar un viaje, tanto cliente como conductor se califican (1-5 estrellas)</li>
    <li>Las calificaciones son bidireccionales</li>
    <li>El promedio de estrellas se muestra en el perfil</li>
    <li>Ambas calificaciones deben existir para cerrar el viaje</li>
</ul>

${role === 'admin' ? `
<h3>10. Panel de Administrador</h3>
<h4>Gestion de Usuarios</h4>
<ul>
    <li>Ver todos los usuarios registrados (clientes y conductores)</li>
    <li>Estado de 2FA de cada usuario</li>
    <li>Ver y gestionar todos los viajes</li>
</ul>
<h4>Gestion Financiera</h4>
<ul>
    <li><strong>Recargas:</strong> Aprobar o rechazar solicitudes de recarga</li>
    <li><strong>Retiros:</strong> Aprobar, rechazar o marcar como realizado con referencia bancaria</li>
    <li><strong>Comision por retiro:</strong> Configurable (default 10%) - Gastos de Plataforma</li>
    <li><strong>Liquidacion:</strong> Muestra Comision Viajes + Comision Retiros = Total Liquidacion</li>
</ul>
<h4>Configuracion</h4>
<ul>
    <li><strong>Tasa BCV:</strong> Actualizar tipo de cambio diario</li>
    <li><strong>Datos bancarios:</strong> Configurar cuenta de TuRides para recibir recargas</li>
    <li><strong>Comision de retiro:</strong> Porcentaje que cobra la plataforma por cada retiro</li>
</ul>
` : ''}

<div class="help-warn" style="margin-top: 20px;">
    <strong>TuRides v1.0</strong> | Transporte Privado de Pasajeros | Venezuela<br>
    &copy; 2026 TuRides Inc.
</div>`;
    },

    printHelp() {
        window.print();
    },

    setupEventListeners() {
        document.getElementById('login-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = document.getElementById('login-email').value;
            const pass = document.getElementById('login-password').value;
            try {
                const result = await API.post('/api/login', { email, password: pass });
                if (result.error) { this.showToast(result.error, 'error'); return; }
                if (result.twoFactorRequired) {
                    this._twoFactorPending = true;
                    this._twoFactorUserId = result.userId;
                    document.getElementById('login-card').style.display = 'none';
                    document.getElementById('twofa-card').style.display = 'block';
                    document.getElementById('twofa-code').value = '';
                    document.getElementById('twofa-code').focus();
                    return;
                }
                this.session = result;
                localStorage.setItem('turides_session', JSON.stringify(result));
                this._setupStatus = await API.get('/api/setup/status');
                this.route();
            } catch(err) { this.showToast('Error de conexion.', 'error'); }
        });

        document.getElementById('twofa-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = document.getElementById('twofa-code').value;
            try {
                const result = await API.post('/api/login/2fa-verify', { userId: this._twoFactorUserId, code });
                if (result.error) { this.showToast(result.error, 'error'); return; }
                this._twoFactorPending = false;
                this._twoFactorUserId = null;
                document.getElementById('twofa-card').style.display = 'none';
                document.getElementById('login-card').style.display = 'block';
                this.session = result;
                localStorage.setItem('turides_session', JSON.stringify(result));
                this.route();
            } catch(err) { this.showToast('Error de conexion.', 'error'); }
        });

        document.getElementById('twofa-cancel')?.addEventListener('click', () => {
            this._twoFactorPending = false;
            this._twoFactorUserId = null;
            document.getElementById('twofa-card').style.display = 'none';
            document.getElementById('login-card').style.display = 'block';
        });

        document.getElementById('setup-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('setup-name').value;
            const email = document.getElementById('setup-email').value;
            const phone = document.getElementById('setup-phone').value;
            const password = document.getElementById('setup-password').value;
            const confirm = document.getElementById('setup-confirm').value;
            if (password !== confirm) { this.showToast('Las contrasenas no coinciden', 'error'); return; }
            try {
                const result = await API.post('/api/setup/admin', { name, email, phone, password });
                if (result.error) { this.showToast(result.error, 'error'); return; }
                this.showToast('Administrador creado! Ahora inicia sesion.', 'success');
                this._setupStatus = await API.get('/api/setup/status');
                document.getElementById('view-setup').querySelectorAll('input').forEach(i => i.value = '');
                this.route();
            } catch(err) { this.showToast('Error de conexion.', 'error'); }
        });

        document.querySelectorAll('input[name="reg-role"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.querySelectorAll('input[name="reg-role"]').forEach(r => r.closest('.payment-method-option').classList.remove('selected'));
                e.target.closest('.payment-method-option').classList.add('selected');
                document.getElementById('reg-conductor-block').style.display = e.target.value === 'conductor' ? 'block' : 'none';
            });
        });

        document.querySelectorAll('input[name="reg-vehicle-type"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.querySelectorAll('input[name="reg-vehicle-type"]').forEach(r => r.closest('.payment-method-option').classList.remove('selected'));
                e.target.closest('.payment-method-option').classList.add('selected');
                document.getElementById('reg-carro-details').style.display = e.target.value === 'carro' ? 'block' : 'none';
                document.getElementById('reg-moto-details').style.display = (e.target.value === 'moto' || e.target.value === 'moto_delivery') ? 'block' : 'none';
                document.getElementById('reg-camion-details').style.display = e.target.value === 'camion' ? 'block' : 'none';
            });
        });

        document.querySelectorAll('input[name="reg-moto-service"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.querySelectorAll('input[name="reg-moto-service"]').forEach(r => r.closest('.payment-method-option').classList.remove('selected'));
                e.target.closest('.payment-method-option').classList.add('selected');
            });
        });

        document.getElementById('register-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                name: document.getElementById('reg-name').value,
                phone: document.getElementById('reg-phone').value,
                email: document.getElementById('reg-email').value,
                password: document.getElementById('reg-password').value,
                role: document.querySelector('input[name="reg-role"]:checked')?.value || 'cliente'
            };
            if (data.role === 'conductor') {
                const vehicleType = document.querySelector('input[name="reg-vehicle-type"]:checked')?.value || 'carro';
                data.vehicleData = {
                    type: vehicleType,
                    brand: document.getElementById('reg-brand').value || '',
                    model: document.getElementById('reg-model').value || '',
                    tariffMode: 'kilometros'
                };
                if (vehicleType === 'carro') {
                    data.vehicleData.passengers = document.getElementById('reg-passengers').value || 4;
                    data.vehicleData.suitcases = document.getElementById('reg-suitcases').value || 2;
                } else if (vehicleType === 'moto' || vehicleType === 'moto_delivery') {
                    data.vehicleData.motoService = document.querySelector('input[name="reg-moto-service"]:checked')?.value || 'moto_viajes';
                    if (data.vehicleData.motoService === 'moto_ambas') {
                        data.vehicleData.type = 'moto_ambas';
                    }
                } else if (vehicleType === 'camion') {
                    data.vehicleData.capacity = document.getElementById('reg-camion-capacity')?.value || '1';
                    data.vehicleData.interiorTrips = document.getElementById('reg-camion-interior')?.value || 'si';
                    if (data.vehicleData.capacity === '1') data.vehicleData.type = 'mudanza_pickup';
                    else if (data.vehicleData.capacity === '3.5') data.vehicleData.type = 'mudanza_350';
                    else data.vehicleData.type = 'mudanza_750';
                }
            }
            try {
                const result = await API.post('/api/register', data);
                if (result.error) { this.showToast(result.error, 'error'); return; }
                this.showToast('Registro completado! Accede ahora.', 'success');
                document.getElementById('register-card').style.display = 'none';
                document.getElementById('login-card').style.display = 'block';
                e.target.reset();
            } catch(err) { this.showToast('Error de conexion.', 'error'); }
        });

        document.getElementById('client-search-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.processAutomatedSearch();
        });

        document.querySelectorAll('input[name="vehicle-type"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.querySelectorAll('input[name="vehicle-type"]').forEach(r => r.closest('.payment-method-option').classList.remove('selected'));
                e.target.closest('.payment-method-option').classList.add('selected');
                const mensajeroForm = document.getElementById('mensajero-order-form');
                const mudanzaForm = document.getElementById('mudanza-order-form');
                if (mensajeroForm) mensajeroForm.style.display = e.target.value === 'mensajero' ? 'block' : 'none';
                if (mudanzaForm) mudanzaForm.style.display = e.target.value === 'mudanza' ? 'block' : 'none';
                const efectivoOption = document.getElementById('efectivo-option');
                if (efectivoOption) efectivoOption.style.display = e.target.value === 'mudanza' ? 'flex' : 'none';
                if (e.target.value === 'mensajero') {
                    const pagoMovil = document.querySelector('input[name="payment-method"][value="pago_movil"]');
                    if (pagoMovil) pagoMovil.disabled = true;
                    const efectivo = document.querySelector('input[name="payment-method"][value="efectivo"]');
                    if (efectivo) efectivo.disabled = true;
                    const rkm = document.querySelector('input[name="payment-method"][value="rkm"]');
                    if (rkm) { rkm.checked = true; rkm.closest('.payment-method-option')?.classList.add('selected'); }
                } else {
                    const pagoMovil = document.querySelector('input[name="payment-method"][value="pago_movil"]');
                    if (pagoMovil) pagoMovil.disabled = false;
                    const efectivo = document.querySelector('input[name="payment-method"][value="efectivo"]');
                    if (efectivo) efectivo.disabled = false;
                }
            });
        });

        document.querySelectorAll('input[name="payment-method"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.querySelectorAll('input[name="payment-method"]').forEach(r => r.closest('.payment-method-option').classList.remove('selected'));
                e.target.closest('.payment-method-option').classList.add('selected');
            });
        });

        document.querySelectorAll('input[name="reg-vehicle-type"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                document.querySelectorAll('input[name="reg-vehicle-type"]').forEach(r => r.closest('.payment-method-option').classList.remove('selected'));
                e.target.closest('.payment-method-option').classList.add('selected');
            });
        });
    },

    async renderClienteDashboard() {
        const allTrips = await API.get('/api/trips');
        const trips = allTrips.filter(t => t.clientId === this.session.id);
        const activeTrip = trips.find(t => ['pendiente', 'aceptado', 'completado', 'pago_verificado'].includes(t.status));
        const activeContainer = document.getElementById('cliente-active-trip');
        const searchCard = document.getElementById('cliente-search-container');

        if (activeTrip) {
            searchCard.style.display = 'none';
            activeContainer.style.display = 'block';
            let statusMsg = 'Esperando confirmacion del conductor...';
            let statusBadge = 'text-cyan animate-pulse';
            if (activeTrip.status === 'aceptado') { statusMsg = 'SOLICITUD ACEPTADA POR EL CONDUCTOR!'; statusBadge = 'text-emerald font-bold'; }
            else if (activeTrip.status === 'completado') {
                if (activeTrip.paymentMethod === 'rkm') {
                    statusMsg = 'Viaje completado. Esperando calificacion para transferir pago...';
                } else {
                    statusMsg = 'Viaje completado. Califica tu experiencia.';
                }
                statusBadge = 'text-cyan animate-pulse';
            }
            else if (activeTrip.status === 'pago_verificado') { statusMsg = 'Pago verificado. Califica tu experiencia.'; statusBadge = 'text-emerald font-bold'; }
            else if (activeTrip.status === 'calificado') { statusMsg = 'Viaje finalizado. Gracias!'; statusBadge = 'text-purple font-bold'; }
            const paymentLabel = activeTrip.paymentMethod === 'rkm' ? 'Billetera RKM' : 'Pago Movil';
            const farePeriodLabels = { normal: '', pico: ' (Hora Pico +25%)', noche: ' (Noche +20%)' };
            const fareLabel = farePeriodLabels[activeTrip.farePeriod] || '';

            let html = `<div class="glass-card">
                <div class="flex justify-between items-center mb-4 border-b border-gray pb-2">
                    <h3 class="text-xl font-bold">Carrera Solicitada</h3>
                    <span class="badge ${statusBadge}">${activeTrip.status.toUpperCase()}</span>
                </div>`;

            if (activeTrip.status === 'aceptado') {
                html += `<div class="acceptance-banner"><span class="banner-icon">🎉</span><p class="banner-title">Conductor ha Aceptado tu Solicitud!</p><p class="banner-text">El conductor <strong>${activeTrip.conductorName}</strong> se pondra en contacto contigo al <strong>${activeTrip.conductorPhone}</strong>.</p></div>`;
            }

            html += `
                <div class="p-3 bg-gray rounded mb-4"><p class="text-xs text-gray uppercase">Estado del Viaje</p><p class="font-bold text-sm ${statusBadge}">${statusMsg}</p></div>
                <div class="grid grid-2 gap-4 mb-4">
                    <div><p class="text-xs text-gray">Conductor</p><p class="font-bold">${activeTrip.conductorName}</p><p class="text-xs text-gray font-mono">${activeTrip.conductorPhone}</p></div>
                    <div><p class="text-xs text-gray">Vehiculo</p><p class="font-bold text-sm">${activeTrip.conductorVehicle}</p></div>
                </div>
                <div class="mb-4"><p class="text-xs text-gray">Ruta</p><p class="text-sm"><strong>Origen:</strong> ${activeTrip.originAddress}</p><p class="text-sm"><strong>Destino:</strong> ${activeTrip.destinationAddress}</p><p class="text-sm"><strong>Distancia:</strong> ${activeTrip.distance.toFixed(1)} km</p></div>
                <div class="pricing-card flex justify-between items-center mb-4"><span class="font-bold text-sm">Tarifa${fareLabel}</span><div class="text-right"><span class="text-2xl font-extrabold text-emerald">$${activeTrip.price.toFixed(2)}</span><br><span class="text-xs text-gray">Bs ${this.toBs(activeTrip.price)}</span></div></div>
                <div class="p-3 bg-dark rounded mb-4 flex justify-between items-center"><span class="text-xs text-gray">Metodo de Pago</span><span class="badge ${activeTrip.paymentMethod === 'rkm' ? 'text-emerald' : 'text-cyan'}">${paymentLabel}</span></div>`;

            if (activeTrip.status === 'aceptado') {
                if (activeTrip.paymentMethod === 'rkm') {
                    html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4"><p class="text-xs text-emerald font-bold font-heading">El pago se realizara automaticamente al finalizar el viaje.</p><p class="text-xs text-gray mt-1">Saldo actual: <strong>$${this.session.balance.toFixed(2)}</strong></p></div>`;
                } else {
                    html += `<div class="p-3 bg-dark rounded border-l-cyan mb-4"><p class="text-xs text-cyan font-bold font-heading">Al llegar al destino, realizare un Pago Movil al conductor.</p><p class="text-xs text-gray mt-1">El conductor te indicara sus datos bancarios para el pago.</p></div>`;
                }
                html += `<button onclick="App.completeTrip('${activeTrip.id}')" class="btn btn-emerald w-full">Finalizar Viaje y Pagar</button>`;
            } else if (activeTrip.status === 'completado') {
                if (activeTrip.paymentMethod === 'rkm') {
                    html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4"><p class="text-xs text-emerald font-bold font-heading">Viaje completado. Califica al conductor para completar el pago.</p><p class="text-xs text-gray mt-1">Saldo actual: <strong>$${this.session.balance.toFixed(2)}</strong></p></div>
                    <button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.conductorId}', '${activeTrip.conductorName}', 'cliente')" class="btn btn-purple w-full">Calificar al Conductor ⭐</button>`;
                } else {
                    html += `<div class="p-3 bg-dark rounded border-l-cyan mb-4"><p class="text-xs text-cyan font-bold font-heading">Viaje completado. Califica tu experiencia.</p></div>
                    <button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.conductorId}', '${activeTrip.conductorName}', 'cliente')" class="btn btn-purple w-full">Calificar al Conductor ⭐</button>`;
                }
            } else if (activeTrip.status === 'pago_verificado') {
                html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4"><p class="text-xs text-emerald font-bold font-heading">Pago verificado. Califica tu experiencia.</p></div>
                <button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.conductorId}', '${activeTrip.conductorName}', 'cliente')" class="btn btn-purple w-full">Calificar al Conductor ⭐</button>`;
            } else if (activeTrip.status === 'calificado') {
                html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4"><p class="text-xs text-emerald font-bold font-heading">Viaje finalizado. Gracias por usar TuRides!</p></div>`;
            } else {
                html += `<div class="p-3 bg-gray rounded mb-4"><p class="text-xs text-gray">Esperando respuesta del conductor...</p></div>
                <button onclick="App.cancelTrip('${activeTrip.id}')" class="btn btn-red w-full mb-2">Cancelar Solicitud</button>`;
            }
            html += `</div>`;
            activeContainer.innerHTML = html;
        } else {
            searchCard.style.display = 'block';
            activeContainer.style.display = 'none';
        }

        const historyContainer = document.getElementById('cliente-history');
        const closedTrips = trips.filter(t => ['completado', 'rechazado', 'calificado'].includes(t.status)).reverse();
        if (closedTrips.length === 0) {
            historyContainer.innerHTML = `<p class="text-center text-gray p-4">No has realizado solicitudes anteriores.</p>`;
        } else {
            const defaultCount = 5;
            const initial = closedTrips.slice(0, defaultCount);
            const hidden = closedTrips.slice(defaultCount);
            let thtml = '<table class="table"><thead><tr><th>Conductor</th><th>Ruta</th><th>Precio</th><th>Pago</th><th>Calificacion</th><th>Estado</th></tr></thead><tbody>';
            const renderHistoryRow = (t) => {
                const sc = t.status === 'calificado' ? 'text-purple' : t.status === 'completado' ? 'text-emerald' : 'text-red';
                const pl = t.paymentMethod === 'rkm' ? 'RKM' : 'P.Movil';
                const rHtml = t.conductorRating ? this.renderStarsSmall(t.conductorRating, 1) : '<span class="text-xs text-gray">Pendiente</span>';
                return `<tr><td><strong>${t.conductorName}</strong><br><span class="text-xs text-gray">${t.conductorVehicle}</span></td><td><span class="text-xs font-bold">${t.originAddress}</span> ➔ <span class="text-xs">${t.destinationAddress}</span></td><td class="font-bold text-emerald">$${t.price.toFixed(2)} <span class="text-xs text-gray">Bs ${this.toBs(t.price)}</span></td><td><span class="badge text-cyan">${pl}</span></td><td>${rHtml}</td><td class="${sc} font-bold">${t.status.toUpperCase()}</td></tr>`;
            };
            initial.forEach(t => { thtml += renderHistoryRow(t); });
            thtml += '</tbody></table>';
            if (hidden.length > 0) {
                thtml += `<div id="cliente-history-extra" style="display:none"><table class="table"><tbody>`;
                hidden.forEach(t => { thtml += renderHistoryRow(t); });
                thtml += '</tbody></table></div>';
                thtml += `<div class="text-center mt-2"><button onclick="App.toggleAdminSection('cliente-history-extra')" class="btn btn-sm btn-purple" id="cliente-history-extra-toggle">▼ Mostrar ${hidden.length} solicitudes mas</button></div>`;
            }
            historyContainer.innerHTML = thtml;
        }

        const fareInfoEl = document.getElementById('cliente-fare-info');
        if (fareInfoEl) {
            const labels = { normal: 'Tarifa Normal', pico: 'Hora Pico (+25%)', noche: 'Noche (+20%)' };
            fareInfoEl.textContent = labels[this._fareInfo.period] || 'Tarifa Normal';
        }

        this.renderClientSettings().catch(() => {});
    },

    async processAutomatedSearch() {
        const origin = document.getElementById('client-origin-address').value;
        const dest = document.getElementById('client-destination-address').value;
        const paymentMethod = document.querySelector('input[name="payment-method"]:checked')?.value || 'rkm';
        const vehicleType = document.querySelector('input[name="vehicle-type"]:checked')?.value || 'carro';
        const distBadge = document.getElementById('gps-calculated-distance-badge');
        const listDiv = document.getElementById('available-conductors-list');
        if (!origin || !dest) { this.showToast('Introduce direccion de salida y llegada.', 'error'); return; }
        if (distBadge) { distBadge.innerHTML = `Calculando distancia...`; distBadge.style.display = 'block'; }
        listDiv.innerHTML = `<div class="p-4 bg-gray rounded text-center"><p class="text-cyan font-bold">Buscando ruta...</p></div>`;
        let simulatedKm = await this.calculateDistance(origin, dest);
        const geocodingFailed = !simulatedKm || simulatedKm <= 0;
        if (geocodingFailed) {
            if (vehicleType === 'mensajero') {
                simulatedKm = 1.0;
            } else if (vehicleType === 'mudanza') {
                simulatedKm = 5.0;
            } else {
                simulatedKm = 5.0;
            }
            if (distBadge) { distBadge.innerHTML = `Distancia estimada: <strong class="text-yellow">${simulatedKm.toFixed(1)} km</strong> <span class="text-xs text-gray">(no se pudo geolocalizar, estimado)</span>`; }
        } else {
            if (distBadge) { distBadge.innerHTML = `Distancia calculada: <strong class="text-cyan">${simulatedKm.toFixed(1)} km</strong>`; }
        }
        this.calculatedDistance = simulatedKm;
        if (distBadge) { distBadge.innerHTML = `Kilometros calculados: <strong class="text-cyan">${simulatedKm.toFixed(1)} km</strong>`; distBadge.style.display = 'block'; }
        let searchType = vehicleType;
        if (vehicleType === 'mudanza') {
            searchType = document.getElementById('mudanza-subtype')?.value || 'mudanza_pickup';
        }
        const maxDist = KILOMETER_RATE_CONFIG[searchType]?.maxDistance;
        if (maxDist && simulatedKm > maxDist) { listDiv.innerHTML = `<div class="p-4 bg-gray rounded text-center"><p class="text-red font-bold">Distancia maxima para ${searchType} es ${maxDist} km. Tu ruta es ${simulatedKm.toFixed(1)} km.</p></div>`; return; }
        this.foundConductors = await API.get(`/api/conductors/available?distance=${simulatedKm}&vehicleType=${searchType}`);
        if (this.foundConductors.length === 0) { const typeNames = { carro: 'carro', camioneta: 'camioneta', moto: 'moto', moto_delivery: 'moto delivery', mensajero: 'mensajero', mudanza_pickup: 'pick-up', mudanza_350: 'camion 350', mudanza_750: 'camion 750' }; listDiv.innerHTML = `<div class="p-4 bg-gray rounded text-center"><p class="text-red font-bold">Sin conductores de ${typeNames[searchType] || searchType} disponibles</p></div>`; return; }
        let html = '';
        const fareLabels = { normal: '', pico: ' (HP +25%)', noche: ' (Noche +20%)' };
        const fareTag = fareLabels[this.foundConductors[0]?.farePeriod] || '';
        if (fareTag) {
            html += `<div class="p-3 rounded mb-3 text-center font-bold text-xs border-l-cyan" style="background:rgba(6,182,212,0.1); border:1px solid rgba(6,182,212,0.2);">⚡ Tarifa dinamica activa: ${fareTag} (Multiplicador: x${this.foundConductors[0]?.fareMultiplier || 1})</div>`;
        }
        this.foundConductors.forEach(c => {
            const ml = c.tariffMode === 'fijo' ? 'Tarifa Fija' : 'Por Km';
            const hasRKM = this.session.balance >= c.calculatedPrice;
            const rs = hasRKM ? '<span class="text-emerald text-xs font-bold">✓ Saldo suficiente</span>' : '<span class="text-red text-xs font-bold">✗ Saldo insuficiente</span>';
            const stars = this.renderStarsSmall(c.avgRating, c.ratingCount);
            const vIcons = { carro: '🚗', camioneta: '🚙', moto: '🏍️', moto_delivery: '🛵', mensajero: '🚶', mudanza_pickup: '🛻', mudanza_350: '🚛', mudanza_750: '🚚' };
            const vIcon = vIcons[c.vehicle?.type] || '🚗';
            html += `<div class="glass-card mb-3 border-l-purple p-4 flex justify-between items-center gap-4 flex-wrap">
                <div class="flex-grow min-w-[200px]"><div class="flex items-center gap-2 mb-1"><h4 class="font-bold text-md text-purple">${c.name}</h4><span class="badge text-emerald bg-purple-dark text-xs">Cel: ${c.phone}</span></div><div class="mt-1 mb-1">${stars}</div><p class="text-sm font-bold text-cyan mt-1">${vIcon} ${c.vehicle.brand} ${c.vehicle.model}</p><p class="text-xs text-gray font-bold">👥 ${c.vehicle.passengers} pax | 💼 ${c.vehicle.suitcases} maletas</p><span class="badge text-cyan mt-1 text-xs">${ml}</span>${paymentMethod === 'rkm' ? `<div class="mt-1">${rs}</div>` : ''}</div>
                <div class="text-right flex flex-col gap-2 min-w-[150px]"><div><span class="text-xs text-gray block">Costo</span><span class="text-2xl font-extrabold text-emerald">$${c.calculatedPrice.toFixed(2)}</span><br><span class="text-xs text-gray">Bs ${this.toBs(c.calculatedPrice)}</span></div><div class="flex gap-1 justify-end"><button onclick="App.hireConductor('${c.id}', ${c.calculatedPrice})" class="btn btn-purple btn-sm" ${paymentMethod === 'rkm' && !hasRKM ? 'disabled' : ''}>Contratar</button></div></div>
            </div>`;
        });
        listDiv.innerHTML = html;
        this.showToast('Conductores disponibles listados.', 'success');
    },

    async hireConductor(conductorId, price) {
        const origin = document.getElementById('client-origin-address').value;
        const dest = document.getElementById('client-destination-address').value;
        const paymentMethod = document.querySelector('input[name="payment-method"]:checked')?.value || 'rkm';
        const vehicleType = document.querySelector('input[name="vehicle-type"]:checked')?.value || 'carro';
        let orderDetails = null;
        if (vehicleType === 'mensajero') {
            const serviceType = document.getElementById('mensajero-service-type')?.value || 'documento';
            const senderName = document.getElementById('mensajero-sender-name')?.value || this.session.name;
            const senderPhone = document.getElementById('mensajero-sender-phone')?.value || this.session.phone;
            const receiverName = document.getElementById('mensajero-receiver-name')?.value || '';
            const receiverPhone = document.getElementById('mensajero-receiver-phone')?.value || '';
            const description = document.getElementById('mensajero-description')?.value || '';
            if (!receiverName || !receiverPhone) { this.showToast('Ingresa datos del destinatario.', 'error'); return; }
            orderDetails = { serviceType, senderName, senderPhone, receiverName, receiverPhone, description };
        }
        if (vehicleType === 'mudanza') {
            const subtype = document.getElementById('mudanza-subtype')?.value || 'mudanza_pickup';
            const description = document.getElementById('mudanza-description')?.value || '';
            orderDetails = { subtype, description, senderName: this.session.name, senderPhone: this.session.phone };
        }
        await API.post('/api/trips', { clientId: this.session.id, clientName: this.session.name, clientPhone: this.session.phone, originAddress: origin, destinationAddress: dest, distance: this.calculatedDistance, conductorId, price, paymentMethod, orderDetails });
        this.showToast('Solicitud enviada al Conductor!', 'success');
        this.updateViewContent();
    },

    async completeTrip(tripId) {
        const trips = await API.get('/api/trips');
        const trip = trips.find(t => t.id === tripId);
        if (!trip) return;

        if (trip.paymentMethod === 'rkm') {
            if (this.session.balance < trip.price) {
                this.showToast('Saldo insuficiente en billetera.', 'error');
                return;
            }
            const result = await API.post('/api/payments/rkm', { tripId });
            if (result.error) { this.showToast(result.error, 'error'); return; }
            this.session = await API.get(`/api/users/${this.session.id}`);
            localStorage.setItem('turides_session', JSON.stringify(this.session));
            this.showToast('Pago procesado. Saldo actualizado.', 'success');
            this.renderNavbar();
            this.updateViewContent();
            return;
        }

        this._pendingTripId = tripId;
        this._pendingTripPrice = trip.price;
        this._pendingConductorId = trip.conductorId;
        document.getElementById('payment-modal-amount').textContent = `$${trip.price.toFixed(2)}`;
        document.getElementById('payment-modal-amount-bs').textContent = `Bs ${this.toBs(trip.price)}`;
        document.getElementById('payment-rkm-balance').textContent = `$${this.session.balance.toFixed(2)}`;
        document.getElementById('payment-rkm-balance-bs').textContent = `Bs ${this.toBs(this.session.balance)}`;
        document.getElementById('rkm-payment-balance').textContent = `$${this.session.balance.toFixed(2)}`;
        const rkmConfig = await API.get('/api/rkm-config');
        document.getElementById('pm-bank-name').textContent = rkmConfig.bankName;
        document.getElementById('pm-account-number').textContent = rkmConfig.accountNumber;
        document.getElementById('pm-holder-name').textContent = rkmConfig.holderName;
        document.getElementById('pm-document').textContent = `${rkmConfig.documentType}-${rkmConfig.documentNumber}`;
        this.selectPaymentMethod('pago_movil');
        document.getElementById('payment-modal').classList.remove('hidden');
    },

    selectPaymentMethod(method) {
        const rkmSection = document.getElementById('rkm-payment-section');
        const pagoMovilSection = document.getElementById('pago-movil-section');
        const confirmBtn = document.getElementById('payment-confirm-btn');
        document.querySelectorAll('.payment-method-option-modal').forEach(el => el.classList.remove('selected'));
        if (method === 'rkm') {
            rkmSection.style.display = 'block'; pagoMovilSection.style.display = 'none';
            document.querySelector('.payment-method-option-modal[data-method="rkm"]').classList.add('selected');
            confirmBtn.textContent = 'Pagar con RKM'; confirmBtn.disabled = false;
        } else {
            rkmSection.style.display = 'none'; pagoMovilSection.style.display = 'block';
            document.querySelector('.payment-method-option-modal[data-method="pago_movil"]').classList.add('selected');
            confirmBtn.textContent = 'Confirmar Pago Movil'; confirmBtn.disabled = true;
            this.validatePagoMovil();
        }
        this._selectedPaymentMethod = method;
    },

    validatePagoMovil() {
        const phone = document.getElementById('pm-phone').value.trim();
        const bank = document.getElementById('pm-bank').value;
        const reference = document.getElementById('pm-reference').value.trim();
        const confirmBtn = document.getElementById('payment-confirm-btn');
        const isValid = phone.length >= 10 && bank && reference.length >= 6;
        confirmBtn.disabled = !isValid;
        return isValid;
    },

    async processPayment() {
        const method = this._selectedPaymentMethod || 'rkm';
        const tripId = this._pendingTripId;
        if (method === 'rkm') {
            const result = await API.post('/api/payments/rkm', { tripId });
            if (result.error) { this.showToast(result.error, 'error'); return; }
            this.session = await API.get(`/api/users/${this.session.id}`);
            localStorage.setItem('turides_session', JSON.stringify(this.session));
            this.showToast('Pago procesado exitosamente con RKM.', 'success');
        } else {
            const phone = document.getElementById('pm-phone').value.trim();
            const bank = document.getElementById('pm-bank').value;
            const reference = document.getElementById('pm-reference').value.trim();
            await API.post('/api/payments/pago_movil', { tripId, phone, bankCode: bank, reference });
            this.showToast('Pago movil registrado.', 'info');
        }
        document.getElementById('payment-modal').classList.add('hidden');
        this.updateViewContent();
        this.renderNavbar();
    },

    closePaymentModal() { document.getElementById('payment-modal').classList.add('hidden'); },
    async openRKMRechargeModal() {
        document.getElementById('rkm-recharge-modal').classList.remove('hidden');
        try {
            const config = await API.get('/api/config');
            const infoEl = document.getElementById('rkm-recharge-bank-info');
            if (infoEl && config.bankName) {
                infoEl.innerHTML = `<div class="pm-info-row"><span>Banco:</span><strong>${config.bankName}</strong></div><div class="pm-info-row"><span>Cuenta:</span><strong>${config.accountNumber}</strong></div><div class="pm-info-row"><span>Titular:</span><strong>${config.holderName}</strong></div><div class="pm-info-row"><span>RIF/Cedula:</span><strong>${config.documentType}-${config.documentNumber}</strong></div><div class="pm-info-row"><span>Tasa BCV:</span><strong class="text-cyan">${this._bcvRate || '-'} Bs/$</strong></div>`;
            }
            const phoneEl = document.getElementById('recharge-phone');
            if (phoneEl && this.session.phone) phoneEl.value = this.session.phone;
        } catch(e) { console.error('Error loading config:', e); }
    },
    closeRKMRechargeModal() { document.getElementById('rkm-recharge-modal').classList.add('hidden'); },

    async processRKMRecharge() {
        const amount = parseFloat(document.getElementById('recharge-amount').value);
        const phone = document.getElementById('recharge-phone').value.trim();
        const bankCode = document.getElementById('recharge-bank').value;
        const reference = document.getElementById('recharge-ref').value.trim();
        if (isNaN(amount) || amount <= 0) { this.showToast('Ingresa un monto valido.', 'error'); return; }
        if (!phone || phone.length < 10) { this.showToast('Telefono invalido.', 'error'); return; }
        if (!bankCode) { this.showToast('Selecciona un banco.', 'error'); return; }
        if (!reference || reference.length < 6) { this.showToast('Referencia invalida (min 6 digitos).', 'error'); return; }
        const result = await API.post('/api/wallet/recharge', { userId: this.session.id, amount, phone, bankCode, reference });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.closeRKMRechargeModal();
        this.showToast(result.message || 'Solicitud de recarga enviada. Espera aprobacion del admin.', 'success');
        document.getElementById('recharge-amount').value = '';
        document.getElementById('recharge-bank').value = '';
        document.getElementById('recharge-ref').value = '';
    },

    stopPendingTimer() {
        if (this._pendingTimerInterval) {
            clearInterval(this._pendingTimerInterval);
            this._pendingTimerInterval = null;
        }
    },

    async cancelTrip(tripId) {
        this.stopPendingTimer();
        await API.put(`/api/trips/${tripId}/status`, { status: 'rechazado' });
        this.showToast('Solicitud cancelada.', 'info');
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.renderNavbar();
        await this.updateViewContent();
    },

    showAcceptanceOverlay(trip) {
        const overlay = document.getElementById('acceptance-overlay');
        const details = document.getElementById('acceptance-details');
        if (!overlay || !details) return;
        let html = `<div class="detail-row"><span class="detail-label">Conductor</span><span class="detail-value">${trip.conductorName}</span></div><div class="detail-row"><span class="detail-label">Celular</span><span class="detail-value">${trip.conductorPhone}</span></div><div class="detail-row"><span class="detail-label">Vehiculo</span><span class="detail-value">${trip.conductorVehicle}</span></div><div class="detail-row"><span class="detail-label">Ruta</span><span class="detail-value" style="font-size:0.75rem; text-align:right;">${trip.originAddress} → ${trip.destinationAddress}</span></div><div class="detail-row"><span class="detail-label">Distancia</span><span class="detail-value" style="color:#22d3ee;">${trip.distance.toFixed(1)} km</span></div><div class="detail-row"><span class="detail-label">Tarifa</span><span class="detail-value" style="color:#34d399; font-size:1.1rem;">$${trip.price.toFixed(2)} <span style="font-size:0.75rem; color:#9ca3af;">Bs ${this.toBs(trip.price)}</span></span></div>`;
        if (trip.orderDetails) {
            const od = trip.orderDetails;
            const serviceIcons = { documento: '📄', paquete: '📦', botellon: '💧', compra: '🛒' };
            html += `<div class="detail-row" style="background:rgba(6,182,212,0.1); border-radius:8px; padding:8px; margin-top:8px;"><span class="detail-label">📋 Orden: ${od.orderId || 'N/A'}</span></div>`;
            html += `<div class="detail-row"><span class="detail-label">Servicio</span><span class="detail-value">${serviceIcons[od.serviceType] || '📄'} ${od.serviceType}</span></div>`;
            html += `<div class="detail-row"><span class="detail-label">Remitente</span><span class="detail-value">${od.senderName} (${od.senderPhone})</span></div>`;
            html += `<div class="detail-row"><span class="detail-label">Destinatario</span><span class="detail-value">${od.receiverName} (${od.receiverPhone})</span></div>`;
            if (od.description) html += `<div class="detail-row"><span class="detail-label">Descripcion</span><span class="detail-value">${od.description}</span></div>`;
        }
        details.innerHTML = html;
        overlay.classList.remove('hidden');
        this.showToast('Tu conductor ha aceptado el servicio!', 'success');
    },

    closeAcceptanceOverlay() { document.getElementById('acceptance-overlay')?.classList.add('hidden'); this.updateViewContent(); },

    async renderConductorDashboard() {
        const availToggle = document.getElementById('conductor-availability');
        if (availToggle) availToggle.checked = this.session.available;
        const activeContainer = document.getElementById('conductor-active-trip');
        const radarContainer = document.getElementById('conductor-radar-container');
        const trips = await API.get('/api/trips');
        const activeTrip = trips.find(t => t.conductorId === this.session.id && ['pendiente', 'aceptado', 'completado', 'pago_verificado'].includes(t.status));

        if (activeTrip) {
            radarContainer.style.display = 'none'; activeContainer.style.display = 'block';
            const isRKM = activeTrip.paymentMethod === 'rkm';
            const isEfectivo = activeTrip.paymentMethod === 'efectivo';
            const isPagoMovil = activeTrip.paymentMethod === 'pago_movil';
            const isMudanza = activeTrip.orderDetails && (activeTrip.orderDetails.subtype || activeTrip.orderDetails.description);
            const commission = activeTrip.platformCommission || 0;
            const driverNet = activeTrip.price - commission;
            let paymentLabel = isRKM ? 'Billetera TuRides' : isEfectivo ? 'Efectivo (USD)' : 'Pago Movil';
            let paymentIcon = isRKM ? '💰' : isEfectivo ? '💵' : '📱';
            let paymentColor = isRKM ? 'text-emerald' : isEfectivo ? 'text-yellow' : 'text-cyan';
            let paymentDesc = isRKM ? 'Pago al calificar ambos' : isEfectivo ? 'Pago directo al conductor en efectivo' : 'Transferencia directa del cliente';

            let html = `<div class="glass-card"><div class="flex justify-between items-center mb-4 border-b border-gray pb-2"><h3 class="text-xl font-bold">${isMudanza ? 'Solicitud de Mudanza' : 'Solicitud Entrante'}</h3><span class="badge ${activeTrip.status === 'aceptado' ? 'text-emerald' : 'text-cyan animate-pulse'}">${activeTrip.status.toUpperCase()}</span></div>`;
            if (isMudanza && commission > 0) {
                html += `<div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">📋 Orden: ${activeTrip.orderDetails?.orderId || activeTrip.id}</h4><p class="text-xs text-cyan font-bold">Subtipo: ${activeTrip.orderDetails?.subtype || 'N/A'}</p><p class="text-xs text-gray">Comision Plataforma: <strong class="text-yellow">${(commission * 100 / activeTrip.price).toFixed(0)}% ($${commission.toFixed(2)})</strong> | Tu recibes: <strong class="text-emerald">$${driverNet.toFixed(2)}</strong></p></div>`;
            }
            html += `<div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">Datos del Solicitante:</h4><p class="text-sm"><strong>Cliente:</strong> ${activeTrip.clientName}</p><p class="text-sm"><strong>Celular:</strong> ${activeTrip.clientPhone}</p></div>`;
            html += `<div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1 flex items-center gap-1">${paymentIcon} Metodo de Pago:</h4><p class="text-sm font-bold ${paymentColor}">${paymentLabel}</p><p class="text-xs text-gray mt-1">${paymentDesc}</p></div>`;
            html += `<div class="mb-4"><h4 class="font-bold text-sm mb-1">Detalles de Ruta:</h4><p class="text-sm"><strong>Salida:</strong> ${activeTrip.originAddress}</p><p class="text-sm"><strong>Destino:</strong> ${activeTrip.destinationAddress}</p><p class="text-sm"><strong>Distancia:</strong> ${activeTrip.distance.toFixed(1)} km</p></div>`;
            html += `<div class="pricing-card flex justify-between items-center mb-4"><span class="font-bold text-sm">Pago Total</span><div class="text-right"><span class="text-2xl font-extrabold text-emerald">$${activeTrip.price.toFixed(2)}</span><br><span class="text-xs text-gray">Bs ${this.toBs(activeTrip.price)}</span></div></div>`;

            if (activeTrip.status === 'pendiente') {
                html += `<div class="flex gap-2"><button onclick="App.acceptTripByConductor('${activeTrip.id}')" class="btn btn-emerald flex-1">Aceptar Servicio</button><button onclick="App.rejectTripByConductor('${activeTrip.id}')" class="btn btn-red flex-1">Rechazar</button></div>`;
            } else if (activeTrip.status === 'aceptado') {
                if (isRKM) {
                    html += `<div class="p-3 bg-dark rounded border-l-purple text-center"><p class="text-xs text-emerald font-bold mb-2">Has aceptado este servicio. Contacta al ${activeTrip.clientPhone}.</p><p class="text-xs text-gray">El pago se transferira cuando ambos califiquen el viaje.</p></div>`;
                } else if (isEfectivo) {
                    html += `<div class="p-3 bg-dark rounded border-l-yellow mb-3"><p class="text-xs text-yellow font-bold mb-2">Has aceptado este servicio. Contacta al ${activeTrip.clientPhone}.</p><p class="text-xs text-gray">Cobra $${activeTrip.price.toFixed(2)} en efectivo al llegar al destino.</p><p class="text-xs text-gray mt-1">La comision de $${commission.toFixed(2)} se descontara de tu billetera.</p></div>`;
                } else {
                    const bi = this.session.bankInfo || {};
                    html += `<div class="p-3 bg-dark rounded border-l-cyan mb-3"><p class="text-xs text-cyan font-bold mb-2">Has aceptado este servicio. Contacta al ${activeTrip.clientPhone}.</p><p class="text-xs text-gray">El cliente te transferira $${activeTrip.price.toFixed(2)} directamente a tu cuenta.</p><p class="text-xs text-gray mt-1">Tus datos bancarios: ${bi.bank || ''} ${bi.account || ''}</p></div>`;
                }
                html += `<button onclick="App.completeTripByConductor('${activeTrip.id}')" class="btn btn-purple w-full mt-3">Completar Viaje</button>`;
            } else if (activeTrip.status === 'completado') {
                if (isRKM) {
                    html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4 text-center"><p class="text-xs text-emerald font-bold mb-2">⏳ Viaje completado. Pago pendiente.</p><p class="text-sm text-gray">El pago de <strong class="text-emerald">$${activeTrip.price.toFixed(2)}</strong> se transferira cuando ambos califiquen.</p><p class="text-xs text-gray mt-1">Califica al cliente para recibir tu pago.</p></div><button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.clientId}', '${activeTrip.clientName}', 'conductor')" class="btn btn-purple w-full">Calificar al Cliente ⭐</button>`;
                } else if (isEfectivo) {
                    html += `<div class="p-3 bg-dark rounded border-l-yellow mb-4 text-center"><p class="text-xs text-yellow font-bold mb-2">💵 Pago en efectivo recibido.</p><p class="text-sm text-gray">Cobraste $${activeTrip.price.toFixed(2)} del cliente en efectivo.</p><p class="text-xs text-gray mt-1">Comision: -$${commission.toFixed(2)} de tu billetera.</p></div><button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.clientId}', '${activeTrip.clientName}', 'conductor')" class="btn btn-purple w-full">Calificar al Cliente ⭐</button>`;
                } else {
                    html += `<div class="p-3 bg-dark rounded border-l-cyan mb-4 text-center"><p class="text-xs text-cyan font-bold mb-2">📱 Pago movil completado.</p><p class="text-sm text-gray mb-1">Monto: <strong class="text-emerald">$${activeTrip.price.toFixed(2)}</strong></p><p class="text-xs text-gray">El cliente transfirio directamente a tu cuenta.</p></div><button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.clientId}', '${activeTrip.clientName}', 'conductor')" class="btn btn-purple w-full">Calificar al Cliente ⭐</button>`;
                }
            } else if (activeTrip.status === 'pago_verificado') {
                html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4 text-center"><p class="text-xs text-emerald font-bold mb-2">✅ Pago verificado. Califica al cliente.</p></div><button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.clientId}', '${activeTrip.clientName}', 'conductor')" class="btn btn-purple w-full">Calificar al Cliente ⭐</button>`;
            }
            html += `</div>`;
            activeContainer.innerHTML = html;
        } else {
            radarContainer.style.display = 'block'; activeContainer.style.display = 'none';
            const radarList = document.getElementById('conductor-radar-list');
            if (this.session.available) {
                radarList.innerHTML = `<div class="p-4 text-center"><span class="radar-dot animate-ping mb-2"></span><p class="text-sm text-gray mt-2 font-heading">Consola de Conductor activa.</p><p class="text-xs text-gray">Esperando solicitudes del radar.</p></div>`;
            } else {
                radarList.innerHTML = `<p class="text-center text-red p-4 font-bold">Ponte "Disponible" arriba para recibir solicitudes.</p>`;
            }
        }

        const historyContainer = document.getElementById('conductor-history');
        const closedTrips = trips.filter(t => t.conductorId === this.session.id && ['completado', 'rechazado', 'calificado'].includes(t.status)).reverse();
        if (closedTrips.length === 0) {
            historyContainer.innerHTML = `<p class="text-center text-gray p-4">No has completado servicios.</p>`;
        } else {
            let thtml = '<table class="table"><thead><tr><th>Cliente</th><th>Trayecto</th><th>Precio</th><th>Calificacion</th><th>Estado</th></tr></thead><tbody>';
            closedTrips.forEach(t => {
                const c = t.status === 'calificado' ? 'text-purple' : t.status === 'completado' ? 'text-emerald' : 'text-red';
                const rHtml = t.clientRating ? this.renderStarsSmall(t.clientRating, 1) : '<span class="text-xs text-gray">Pendiente</span>';
                thtml += `<tr><td><strong>${t.clientName}</strong></td><td><span class="text-xs font-bold">${t.originAddress}</span> ➔ <span class="text-xs">${t.destinationAddress}</span></td><td class="font-bold text-emerald">$${t.price.toFixed(2)} <span class="text-xs text-gray">Bs ${this.toBs(t.price)}</span></td><td>${rHtml}</td><td class="${c} font-bold">${t.status.toUpperCase()}</td></tr>`;
            });
            thtml += '</tbody></table>';
            historyContainer.innerHTML = thtml;
        }

        this.renderConductorWallet();
    },

    async renderConductorWallet() {
        const walletEl = document.getElementById('conductor-wallet');
        if (!walletEl) return;
        const withdrawals = await API.get('/api/wallet/withdrawals');
        const myWithdrawals = withdrawals.filter(w => w.conductorId === this.session.id);
        const pendingW = myWithdrawals.filter(w => w.status === 'pendiente');
        const approvedW = myWithdrawals.filter(w => w.status === 'aprobada');
        const bankInfo = this.session.bankInfo || {};
        const hasBank = bankInfo.bank && bankInfo.account;

        const trips = await API.get('/api/trips');
        const myCompleted = trips.filter(t => t.conductorId === this.session.id && ['completado', 'pago_verificado', 'calificado'].includes(t.status) && t.paymentStatus === 'pagado');
        const totalEarned = myCompleted.reduce((acc, t) => acc + t.price, 0);



        let html = `
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3 flex items-center gap-2">💰 Mi Billetera</h3>
                <div class="pricing-card flex justify-between items-center mb-3">
                    <span class="font-bold">Saldo Disponible</span>
                    <div class="text-right">
                        <span class="text-2xl font-extrabold text-emerald">$${this.session.balance.toFixed(2)}</span><br>
                        <span class="text-xs text-gray">Bs ${this.toBs(this.session.balance)}</span>
                    </div>
                </div>
                <div class="p-3 bg-gray rounded mb-3">
                    <p class="text-xs text-gray">Total ganado (viajes completados):</p>
                    <p class="text-sm font-bold text-emerald">$${totalEarned.toFixed(2)} <span class="text-xs text-gray">(Bs ${this.toBs(totalEarned)})</span> <span class="text-xs text-cyan">| ${myCompleted.length} viajes</span></p>
                </div>`;

        if (hasBank) {
            html += `
                <div class="p-3 bg-gray rounded mb-3">
                    <p class="text-xs text-gray">Cuenta bancaria registrada:</p>
                    <p class="text-sm font-bold">${bankInfo.bank} - ${bankInfo.account}</p>
                    <p class="text-xs text-gray">Titular: ${bankInfo.name || '-'} | Tel: ${bankInfo.phone || '-'}</p>
                </div>`;
        }

        html += `</div>`;

        // === SECCION PASS TuRides ===
        try {
            const passStatus = await API.get('/api/pass/status');
            const referrals = await API.get('/api/pass/referrals');
            const currentTier = PASS_TIERS_CONFIG[passStatus.currentLevel] || PASS_TIERS_CONFIG.bronce;
            const isActive = !!passStatus.activePass;
            const pctUsed = isActive ? Math.min(100, Math.round((passStatus.activePass.earned / passStatus.activePass.limit) * 100)) : 0;
            let passHtml = `<div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3 flex items-center gap-2">🎫 PASS TuRides</h3>`;

            if (isActive) {
                const ap = passStatus.activePass;
                const consumedColor = pctUsed <= 30 ? 'text-emerald' : pctUsed <= 60 ? 'text-yellow' : 'text-red';
                passHtml += `
                    <div class="pricing-card mb-3">
                        <div class="flex justify-between items-center mb-2">
                            <div><span class="font-bold">Nivel: <span class="text-purple">${ap.label}</span></span></div>
                            <span class="text-xs text-gray">Activado: ${new Date(ap.purchasedAt).toLocaleDateString()}</span>
                        </div>
                        <div class="flex justify-between items-center mb-2">
                            <span class="text-sm font-bold">Valor:</span>
                            <span class="text-sm font-bold text-cyan">$${ap.limit.toFixed(2)}</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="text-sm font-bold">Consumido:</span>
                            <span class="text-sm font-extrabold ${consumedColor}">$${ap.earned.toFixed(2)}</span>
                        </div>
                        ${pctUsed >= 70 ? `<p class="text-xs ${consumedColor} font-bold mt-2 text-center">⚠️ Tu PASS esta al ${pctUsed}%. Cuando se agote, compra otro PASS.</p>` : ''}
                    </div>`;
            } else {
                passHtml += `<div class="p-3 bg-gray rounded mb-3 text-center">
                    <p class="text-sm text-gray">No tienes PASS activo.</p>
                    <p class="text-xs text-gray mt-1">Adquiere un PASS para generar sin comisiones.</p>
                </div>`;
            }

            if (passStatus.pendingPurchases && passStatus.pendingPurchases.length > 0) {
                passStatus.pendingPurchases.forEach(p => {
                    const ptier = PASS_TIERS_CONFIG[p.passlevel];
                    passHtml += `<div class="p-3 bg-dark rounded mb-3 border-l-yellow">
                        <div class="flex justify-between items-center">
                            <div><span class="text-xs text-gray">PASS ${ptier.label} - Pago Movil</span><br><span class="text-xs text-yellow font-bold">⏳ Pendiente de verificacion admin</span><br><span class="text-xs text-gray">${new Date(p.createdat).toLocaleDateString()}</span></div>
                            <span class="text-sm font-bold text-yellow">$${p.amount.toFixed(2)}</span>
                        </div>
                    </div>`;
                });
            }

            const requiredLevel = passStatus.currentLevel;
            const availablePasses = requiredLevel === 'bronce' ? ['bronce'] : requiredLevel === 'plata' ? ['bronce','plata'] : ['bronce','plata','oro'];

            passHtml += `<div class="p-3 bg-gray rounded mb-3">
                <p class="text-xs text-gray mb-1">Progreso ${passStatus.nextLevel ? `hacia ${PASS_TIERS_CONFIG[passStatus.nextLevel]?.label || passStatus.nextLevel}` : 'Nivel Maximo'}</p>
                <div class="flex justify-between items-center">
                    <span class="text-sm font-bold">${passStatus.progressToNext}/3 PASS ${passStatus.currentLevel === 'bronce' ? 'Bronce' : 'Plata'} comprados</span>
                    ${passStatus.purchasesNeeded > 0 ? `<span class="badge text-cyan">Faltan ${passStatus.purchasesNeeded}</span>` : '<span class="badge text-emerald">DESBLOQUEADO</span>'}
                </div>
            </div>`;

            if (passStatus.referralCredits > 0) {
                passHtml += `<div class="p-3 bg-dark rounded mb-3 border-l-purple">
                    <div class="flex justify-between items-center">
                        <div><span class="text-xs text-gray">Creditos por Referidos</span><br><span class="text-lg font-extrabold text-emerald">$${passStatus.referralCredits.toFixed(2)}</span></div>
                        <button onclick="App.openPassBuyModal()" class="btn btn-purple btn-sm" style="font-size:11px;">Aplicar a PASS</button>
                    </div>
                </div>`;
            }

            passHtml += `<button onclick="App.openPassBuyModal()" class="btn btn-purple w-full mb-3">🎫 ${isActive ? 'Comprar otro PASS' : 'Adquirir PASS'}</button>`;
            passHtml += `</div>`;

            // Tabla de Referidos
            passHtml += `<div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3 flex items-center gap-2">🎁 Mis Referidos <span class="badge text-cyan">${referrals.length}</span></h3>`;
            if (referrals.length === 0) {
                passHtml += `<p class="text-center text-gray text-sm p-3">No tienes referidos aun. Comparte tu codigo para ganar $5 por referido.</p>`;
            } else {
                passHtml += `<div style="overflow-x:auto;"><table class="table"><thead><tr><th>Nombre</th><th>Fecha</th><th>PASS</th><th>Estado</th><th>Credito</th></tr></thead><tbody>`;
                referrals.forEach(r => {
                    const statusBadge = r.status === 'efectivo' ? 'text-emerald' : r.status === 'rechazado' ? 'text-red' : 'text-cyan';
                    const statusLabel = r.status === 'efectivo' ? 'EFECTIVO' : r.status === 'rechazado' ? 'RECHAZADO' : 'PENDIENTE';
                    const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '-';
                    passHtml += `<tr><td class="font-bold">${r.referredName || '-'}</td><td class="text-xs">${date}</td><td class="text-xs">$${(r.passAmount || 0).toFixed(0)}</td><td><span class="badge ${statusBadge}" style="font-size:10px;">${statusLabel}</span></td><td class="font-bold text-emerald">$${(r.commission || 0).toFixed(2)}</td></tr>`;
                });
                passHtml += `</tbody></table></div>`;
            }

            const totalCredits = referrals.filter(r => r.status === 'efectivo').reduce((a, r) => a + (r.commission || 0), 0);
            passHtml += `<div class="p-3 bg-dark rounded mt-2"><div class="flex justify-between"><span class="text-xs text-gray">Creditos Acumulados:</span><span class="font-bold text-emerald">$${totalCredits.toFixed(2)}</span></div></div>`;
            passHtml += `</div>`;

            html += passHtml;
        } catch(e) { console.error('PASS section error:', e); }

        html += `</div>`;

        html += `
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3">🏦 ${hasBank ? 'Actualizar Cuenta Bancaria' : 'Configurar Cuenta Bancaria'}</h3>
                <p class="text-xs text-gray mb-3">${hasBank ? 'Modifica los datos de tu cuenta para recibir retiros.' : 'Ingresa los datos de tu cuenta para poder solicitar retiros.'}</p>
                <div class="form-group">
                    <label>Banco</label>
                    <select id="driver-bank-select" class="input">
                        <option value="">Seleccionar banco</option>
                        ${BANKS.map(b => `<option value="${b.code}" ${bankInfo.bank === b.code ? 'selected' : ''}>${b.code} - ${b.name}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Número de Cuenta</label>
                    <input type="text" id="driver-bank-account" class="input" value="${bankInfo.account || ''}" placeholder="Ej. 0102-1234-5678-9012">
                </div>
                <div class="form-group">
                    <label>Cédula</label>
                    <input type="text" id="driver-bank-cedula" class="input" value="${bankInfo.cedula || ''}" placeholder="V-12345678">
                </div>
                <div class="form-group">
                    <label>Teléfono (Pago Móvil)</label>
                    <input type="tel" id="driver-bank-phone" class="input" value="${bankInfo.phone || this.session.phone || ''}" placeholder="0412-5556677">
                </div>
                <div class="form-group">
                    <label>Nombre del Titular</label>
                    <input type="text" id="driver-bank-name" class="input" value="${bankInfo.name || this.session.name || ''}" placeholder="Nombre como aparece en el banco">
                </div>
                <button onclick="App.saveDriverBankInfo()" class="btn btn-purple w-full">Guardar Cuenta Bancaria</button>
            </div>`;

        if (hasBank) {
            html += `
                <div class="glass-card mb-4">
                    <h3 class="text-lg font-bold mb-3">💸 Solicitar Retiro</h3>
                    <div class="form-group">
                        <label>Monto a retirar ($)</label>
                        <input type="number" id="withdraw-amount" min="1" step="0.01" max="${this.session.balance}" placeholder="Ej. 20.00" class="input">
                    </div>
                    <button onclick="App.requestWithdrawal()" class="btn btn-emerald w-full">Solicitar Retiro a Cuenta Bancaria</button>
                </div>`;
        }

        if (pendingW.length > 0) {
            html += `<div class="glass-card mb-4"><h3 class="text-lg font-bold mb-3 text-cyan">⏳ Retiros Pendientes (${pendingW.length})</h3>`;
            pendingW.forEach(w => {
                html += `<div class="p-3 bg-gray rounded mb-2 flex justify-between items-center"><div><span class="font-bold text-emerald">$${w.amount.toFixed(2)}</span> <span class="text-xs text-gray">(Bs ${w.amountBs})</span></div><span class="badge text-cyan">Pendiente</span></div>`;
            });
            html += `</div>`;
        }

        if (approvedW.length > 0) {
            const showCount = this._withdrawalsShowAll ? approvedW.length : 3;
            const hiddenCount = approvedW.length - showCount;
            html += `<div class="glass-card mb-4"><h3 class="text-lg font-bold mb-3 text-emerald">✅ Retiros Aprobados/Realizados (${approvedW.length})</h3>`;
            approvedW.slice(0, showCount).forEach(w => {
                const date = w.reviewedAt ? new Date(w.reviewedAt).toLocaleDateString() : '-';
                const net = w.netAmount || (w.amount - (w.commission || 0));
                if (w.status === 'realizado') {
                    html += `<div class="p-3 bg-gray rounded mb-2"><div class="flex justify-between items-center"><span class="font-bold text-emerald">$${net.toFixed(2)} transferidos</span><span class="badge text-emerald">REALIZADO</span></div><p class="text-xs text-gray mt-1">Ref: <strong class="text-cyan">${w.reference || 'Sin referencia'}</strong> | ${date}</p><div class="mt-2 flex gap-2"><a href="/api/wallet/withdrawals/${w.id}/ticket" target="_blank" class="btn btn-purple btn-sm" style="font-size:10px;padding:4px 8px;">📄 Ver Ticket PDF</a></div></div>`;
                } else {
                    html += `<div class="p-2 bg-gray rounded mb-1 flex justify-between text-xs"><span>$${w.amount.toFixed(2)} - ${date}</span><span class="badge text-emerald">Aprobado</span></div>`;
                }
            });
            if (hiddenCount > 0 || (showCount < approvedW.length && !this._withdrawalsShowAll)) {
                html += `<button onclick="App._withdrawalsShowAll = !App._withdrawalsShowAll; App.renderConductorWallet();" class="btn btn-sm w-full mt-2" style="background:rgba(255,255,255,0.1);color:#999;font-size:11px;">${this._withdrawalsShowAll ? '⬆️ Mostrar menos' : `⬇️ Mostrar ${hiddenCount} mas`}</button>`;
            }
            html += `</div>`;
        }

        html += `
            <div class="glass-card mt-4">
                <h3 class="text-lg font-bold mb-3">🔐 Seguridad de mi Cuenta</h3>
                <p class="text-xs text-gray mb-3">Cambiar contraseña y configurar autenticación de dos factores.</p>
                <div class="form-group">
                    <label>Contraseña Actual</label>
                    <input type="password" id="sec-current-pw" class="input" placeholder="Tu contraseña actual">
                </div>
                <div class="form-group">
                    <label>Nueva Contraseña</label>
                    <input type="password" id="sec-new-pw" class="input" placeholder="Mínimo 3 caracteres">
                </div>
                <div class="form-group">
                    <label>Confirmar Nueva Contraseña</label>
                    <input type="password" id="sec-confirm-pw" class="input" placeholder="Repite la nueva contraseña">
                </div>
                <button onclick="App.changePassword()" class="btn btn-purple w-full">Cambiar Contraseña</button>
                <hr class="my-4 border-gray">
                <div id="twofa-status-panel"></div>
            </div>`;

        walletEl.innerHTML = html;
        this.renderTwoFactorStatus();
    },

    async saveDriverBankInfo() {
        const bank = document.getElementById('driver-bank-select')?.value;
        const account = document.getElementById('driver-bank-account')?.value?.trim();
        const cedula = document.getElementById('driver-bank-cedula')?.value?.trim();
        const phone = document.getElementById('driver-bank-phone')?.value?.trim();
        const name = document.getElementById('driver-bank-name')?.value?.trim();
        if (!bank) { this.showToast('Selecciona un banco.', 'error'); return; }
        if (!account || account.length < 10) { this.showToast('Numero de cuenta invalido.', 'error'); return; }
        if (!name) { this.showToast('Nombre del titular requerido.', 'error'); return; }
        const bankInfo = { bank, account, cedula, phone, name };
        await API.put(`/api/users/${this.session.id}`, { bankInfo });
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.showToast('Cuenta bancaria guardada.', 'success');
        this.renderConductorWallet();
    },

    async requestWithdrawal() {
        const amount = parseFloat(document.getElementById('withdraw-amount').value);
        if (isNaN(amount) || amount <= 0) { this.showToast('Ingresa un monto valido.', 'error'); return; }
        if (amount > this.session.balance) { this.showToast('Saldo insuficiente.', 'error'); return; }
        const result = await API.post('/api/wallet/withdraw', { conductorId: this.session.id, amount });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.showToast(result.message || 'Retiro solicitado.', 'success');
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.renderNavbar();
        this.renderConductorWallet();
    },

    async renderMensajeroDashboard() {
        const availToggle = document.getElementById('mensajero-availability');
        if (availToggle) availToggle.checked = this.session.available;
        const activeContainer = document.getElementById('mensajero-active-trip');
        const radarContainer = document.getElementById('mensajero-radar-container');
        const trips = await API.get('/api/trips');
        const activeTrip = trips.find(t => t.conductorId === this.session.id && ['pendiente', 'aceptado', 'completado', 'pago_verificado'].includes(t.status));

        if (activeTrip) {
            radarContainer.style.display = 'none'; activeContainer.style.display = 'block';
            const od = activeTrip.orderDetails || {};
            const serviceIcons = { documento: '📄', paquete: '📦', botellon: '💧', compra: '🛒' };
            const typeName = { documento: 'Documento', paquete: 'Paquete', botellon: 'Botellon', compra: 'Retiro de Compra' };

            let html = `<div class="glass-card"><div class="flex justify-between items-center mb-4 border-b border-gray pb-2"><h3 class="text-xl font-bold">Envio Entrante</h3><span class="badge ${activeTrip.status === 'aceptado' ? 'text-emerald' : 'text-cyan animate-pulse'}">${activeTrip.status.toUpperCase()}</span></div>
            <div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">📋 Orden: ${od.orderId || activeTrip.id}</h4><p class="text-xs text-cyan font-bold">${serviceIcons[od.serviceType] || '📄'} ${typeName[od.serviceType] || od.serviceType || 'Envio'}</p></div>
            <div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">Datos del Solicitante:</h4><p class="text-sm"><strong>Cliente:</strong> ${activeTrip.clientName}</p><p class="text-sm"><strong>Celular:</strong> ${activeTrip.clientPhone}</p></div>
            <div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">📍 Ruta:</h4><p class="text-sm"><strong>Retiro:</strong> ${activeTrip.originAddress}</p><p class="text-sm"><strong>Entrega:</strong> ${activeTrip.destinationAddress}</p><p class="text-sm"><strong>Distancia:</strong> ${activeTrip.distance.toFixed(1)} km</p></div>`;
            if (od.senderName || od.receiverName) {
                html += `<div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">👤 Contactos:</h4>`;
                if (od.senderName) html += `<p class="text-sm"><strong>Remitente:</strong> ${od.senderName} (${od.senderPhone})</p>`;
                if (od.receiverName) html += `<p class="text-sm"><strong>Destinatario:</strong> ${od.receiverName} (${od.receiverPhone})</p>`;
                if (od.description) html += `<p class="text-xs text-gray mt-1"><strong>Descripcion:</strong> ${od.description}</p>`;
                html += `</div>`;
            }
            html += `<div class="pricing-card flex justify-between items-center mb-4"><span class="font-bold text-sm">💰 Pago (Billetera)</span><div class="text-right"><span class="text-2xl font-extrabold text-emerald">$${activeTrip.price.toFixed(2)}</span><br><span class="text-xs text-gray">Bs ${this.toBs(activeTrip.price)}</span></div></div>`;

            if (activeTrip.status === 'pendiente') {
                html += `<div class="flex gap-2"><button onclick="App.acceptTripByConductor('${activeTrip.id}')" class="btn btn-emerald flex-1">Aceptar Envio</button><button onclick="App.rejectTripByConductor('${activeTrip.id}')" class="btn btn-red flex-1">Rechazar</button></div>`;
            } else if (activeTrip.status === 'aceptado') {
                html += `<div class="p-3 bg-dark rounded border-l-purple text-center mb-3"><p class="text-xs text-emerald font-bold mb-2">Has aceptado el envio. Contacta al ${activeTrip.clientPhone}.</p><p class="text-xs text-gray">Muestra la orden al retirar el paquete.</p></div>`;
                html += `<button onclick="App.completeTripByConductor('${activeTrip.id}')" class="btn btn-purple w-full">Entrega Realizada ✓</button>`;
            } else if (activeTrip.status === 'completado') {
                html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4 text-center"><p class="text-xs text-emerald font-bold mb-2">⏳ Envio completado. Pago pendiente.</p><p class="text-sm text-gray">El pago de <strong class="text-emerald">$${activeTrip.price.toFixed(2)}</strong> se transferira cuando ambos califiquen.</p><p class="text-xs text-gray mt-1">Califica al cliente para recibir tu pago.</p></div><button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.clientId}', '${activeTrip.clientName}', 'conductor')" class="btn btn-purple w-full">Calificar al Cliente ⭐</button>`;
            } else if (activeTrip.status === 'pago_verificado') {
                html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4 text-center"><p class="text-xs text-emerald font-bold mb-2">Envio completado. Califica al cliente.</p></div><button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.clientId}', '${activeTrip.clientName}', 'conductor')" class="btn btn-purple w-full">Calificar al Cliente ⭐</button>`;
            }
            html += `</div>`;
            activeContainer.innerHTML = html;
        } else {
            radarContainer.style.display = 'block'; activeContainer.style.display = 'none';
            const radarList = document.getElementById('mensajero-radar-list');
            if (this.session.available) {
                radarList.innerHTML = `<div class="p-4 text-center"><span class="radar-dot animate-ping mb-2"></span><p class="text-sm text-gray mt-2 font-heading">Consola de Mensajero activa.</p><p class="text-xs text-gray">Esperando envios del radar.</p></div>`;
            } else {
                radarList.innerHTML = `<p class="text-center text-red p-4 font-bold">Ponte "Disponible" arriba para recibir envios.</p>`;
            }
        }

        const historyContainer = document.getElementById('mensajero-history');
        const closedTrips = trips.filter(t => t.conductorId === this.session.id && ['completado', 'rechazado', 'calificado'].includes(t.status)).reverse();
        if (closedTrips.length === 0) {
            historyContainer.innerHTML = `<p class="text-center text-gray p-4">No has completado envios.</p>`;
        } else {
            let thtml = '<table class="table"><thead><tr><th>Cliente</th><th>Ruta</th><th>Precio</th><th>Calificacion</th><th>Estado</th></tr></thead><tbody>';
            closedTrips.forEach(t => {
                const c = t.status === 'calificado' ? 'text-purple' : t.status === 'completado' ? 'text-emerald' : 'text-red';
                const rHtml = t.clientRating ? this.renderStarsSmall(t.clientRating, 1) : '<span class="text-xs text-gray">Pendiente</span>';
                thtml += `<tr><td><strong>${t.clientName}</strong></td><td><span class="text-xs font-bold">${t.originAddress}</span> ➔ <span class="text-xs">${t.destinationAddress}</span></td><td class="font-bold text-emerald">$${t.price.toFixed(2)} <span class="text-xs text-gray">Bs ${this.toBs(t.price)}</span></td><td>${rHtml}</td><td class="${c} font-bold">${t.status.toUpperCase()}</td></tr>`;
            });
            thtml += '</tbody></table>';
            historyContainer.innerHTML = thtml;
        }

        this.renderMensajeroWallet();
    },

    async renderMensajeroWallet() {
        const walletEl = document.getElementById('mensajero-wallet');
        if (!walletEl) return;
        const withdrawals = await API.get('/api/wallet/withdrawals');
        const myWithdrawals = withdrawals.filter(w => w.conductorId === this.session.id);
        const pendingW = myWithdrawals.filter(w => w.status === 'pendiente');
        const approvedW = myWithdrawals.filter(w => w.status === 'aprobada');
        const bankInfo = this.session.bankInfo || {};
        const hasBank = bankInfo.bank && bankInfo.account;

        const trips = await API.get('/api/trips');
        const myCompleted = trips.filter(t => t.conductorId === this.session.id && ['completado', 'pago_verificado', 'calificado'].includes(t.status) && t.paymentStatus === 'pagado');
        const totalEarned = myCompleted.reduce((acc, t) => acc + t.price, 0);



        let html = `
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3 flex items-center gap-2">💰 Mi Billetera</h3>
                <div class="pricing-card flex justify-between items-center mb-3">
                    <span class="font-bold">Saldo Disponible</span>
                    <span class="text-2xl font-extrabold text-emerald">$${this.session.balance.toFixed(2)}</span>
                </div>
                <p class="text-xs text-gray mb-2">Bs ${this.toBs(this.session.balance)} | Total ganado: $${totalEarned.toFixed(2)}</p>
            </div>`;

        // === SECCION PASS TuRides para Mensajero ===
        try {
            const passStatus = await API.get('/api/pass/status');
            const referrals = await API.get('/api/pass/referrals');
            const currentTier = PASS_TIERS_CONFIG[passStatus.currentLevel] || PASS_TIERS_CONFIG.bronce;
            const isActive = !!passStatus.activePass;
            const pctUsed = isActive ? Math.min(100, Math.round((passStatus.activePass.earned / passStatus.activePass.limit) * 100)) : 0;
            let passHtml = `<div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3 flex items-center gap-2">🎫 PASS TuRides</h3>`;
            if (isActive) {
                const ap = passStatus.activePass;
                const consumedColor = pctUsed <= 30 ? 'text-emerald' : pctUsed <= 60 ? 'text-yellow' : 'text-red';
                passHtml += `
                    <div class="pricing-card mb-3">
                        <div class="flex justify-between items-center mb-2">
                            <div><span class="font-bold">Nivel: <span class="text-purple">${ap.label}</span></span></div>
                            <span class="text-xs text-gray">Activado: ${new Date(ap.purchasedAt).toLocaleDateString()}</span>
                        </div>
                        <div class="flex justify-between items-center mb-2">
                            <span class="text-sm font-bold">Valor:</span>
                            <span class="text-sm font-bold text-cyan">$${ap.limit.toFixed(2)}</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="text-sm font-bold">Consumido:</span>
                            <span class="text-sm font-extrabold ${consumedColor}">$${ap.earned.toFixed(2)}</span>
                        </div>
                        ${pctUsed >= 70 ? `<p class="text-xs ${consumedColor} font-bold mt-2 text-center">⚠️ Tu PASS esta al ${pctUsed}%. Cuando se agote, compra otro PASS.</p>` : ''}
                    </div>`;
            } else {
                passHtml += `<div class="p-3 bg-gray rounded mb-3 text-center"><p class="text-sm text-gray">No tienes PASS activo. Adquiere un PASS para generar sin comisiones.</p></div>`;
            }

            if (passStatus.pendingPurchases && passStatus.pendingPurchases.length > 0) {
                passStatus.pendingPurchases.forEach(p => {
                    const ptier = PASS_TIERS_CONFIG[p.passlevel];
                    passHtml += `<div class="p-3 bg-dark rounded mb-3 border-l-yellow">
                        <div class="flex justify-between items-center">
                            <div><span class="text-xs text-gray">PASS ${ptier.label} - Pago Movil</span><br><span class="text-xs text-yellow font-bold">⏳ Pendiente de verificacion admin</span><br><span class="text-xs text-gray">${new Date(p.createdat).toLocaleDateString()}</span></div>
                            <span class="text-sm font-bold text-yellow">$${p.amount.toFixed(2)}</span>
                        </div>
                    </div>`;
                });
            }

            if (passStatus.referralCredits > 0) {
                passHtml += `<div class="p-3 bg-dark rounded mb-3 border-l-purple"><div class="flex justify-between items-center"><div><span class="text-xs text-gray">Creditos por Referidos</span><br><span class="text-lg font-extrabold text-emerald">$${passStatus.referralCredits.toFixed(2)}</span></div><button onclick="App.openPassBuyModal()" class="btn btn-purple btn-sm" style="font-size:11px;">Aplicar a PASS</button></div></div>`;
            }
            passHtml += `<button onclick="App.openPassBuyModal()" class="btn btn-purple w-full mb-3">🎫 ${isActive ? 'Comprar otro PASS' : 'Adquirir PASS'}</button></div>`;
            if (referrals.length > 0) {
                passHtml += `<div class="glass-card mb-4"><h3 class="text-lg font-bold mb-3">🎁 Mis Referidos <span class="badge text-cyan">${referrals.length}</span></h3>`;
                passHtml += `<div style="overflow-x:auto;"><table class="table"><thead><tr><th>Nombre</th><th>Fecha</th><th>PASS</th><th>Credito</th></tr></thead><tbody>`;
                referrals.forEach(r => {
                    passHtml += `<tr><td class="font-bold">${r.referredName || '-'}</td><td class="text-xs">${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '-'}</td><td class="text-xs">$${(r.passAmount || 0).toFixed(0)}</td><td class="font-bold text-emerald">$${(r.commission || 0).toFixed(2)}</td></tr>`;
                });
                passHtml += `</tbody></table></div></div>`;
            }
            html += passHtml;
        } catch(e) { console.error('PASS mensajero error:', e); }

            html += `${hasBank ? `
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3">💸 Solicitar Retiro</h3>
                <div class="form-group">
                    <label>Monto a retirar ($)</label>
                    <input type="number" id="mensajero-withdraw-amount" min="1" step="0.01" max="${this.session.balance}" placeholder="Ej. 10.00" class="input">
                </div>
                <button onclick="App.requestMensajeroWithdrawal()" class="btn btn-emerald w-full">Solicitar Retiro a Cuenta Bancaria</button>
            </div>` : `<div class="glass-card mb-4"><p class="text-xs text-red text-center">Configura tu cuenta bancaria para solicitar retiros.</p></div>`}
            ${pendingW.length > 0 ? `<div class="glass-card mb-4"><h3 class="text-lg font-bold mb-3 text-cyan">⏳ Retiros Pendientes</h3>${pendingW.map(w => `<div class="p-3 bg-gray rounded mb-2"><p class="text-sm"><strong>$${w.amount.toFixed(2)}</strong> → $${(w.netAmount || w.amount).toFixed(2)} (comision: $${(w.commission || 0).toFixed(2)})</p><p class="text-xs text-gray">Solicitado: ${w.createdAt ? new Date(w.createdAt).toLocaleDateString() : '-'}</p></div>`).join('')}</div>` : ''}
            ${approvedW.length > 0 ? (() => {
                const showCount = this._mensajeroWithdrawalsShowAll ? approvedW.length : 3;
                const hiddenCount = approvedW.length - showCount;
                let ahtml = `<div class="glass-card mb-4"><h3 class="text-lg font-bold mb-3 text-emerald">✅ Retiros Realizados (${approvedW.length})</h3>`;
                approvedW.slice(0, showCount).forEach(w => {
                    const date = w.reviewedAt ? new Date(w.reviewedAt).toLocaleDateString() : '-';
                    const net = w.netAmount || (w.amount - (w.commission || 0));
                    ahtml += `<div class="p-3 bg-gray rounded mb-2"><div class="flex justify-between items-center"><span class="font-bold text-emerald">$${net.toFixed(2)} transferidos</span><span class="badge text-emerald">${w.status.toUpperCase()}</span></div><p class="text-xs text-gray mt-1">Ref: <strong class="text-cyan">${w.reference || 'Sin referencia'}</strong> | ${date}</p>`;
                    if (w.status === 'realizado') ahtml += `<div class="mt-2"><a href="/api/wallet/withdrawals/${w.id}/ticket" target="_blank" class="btn btn-purple btn-sm" style="font-size:10px;padding:4px 8px;">📄 Ver Ticket PDF</a></div>`;
                    ahtml += `</div>`;
                });
                if (hiddenCount > 0 || (showCount < approvedW.length && !this._mensajeroWithdrawalsShowAll)) {
                    ahtml += `<button onclick="App._mensajeroWithdrawalsShowAll = !App._mensajeroWithdrawalsShowAll; App.renderMensajeroWallet();" class="btn btn-sm w-full mt-2" style="background:rgba(255,255,255,0.1);color:#999;font-size:11px;">${this._mensajeroWithdrawalsShowAll ? '⬆️ Mostrar menos' : `⬇️ Mostrar ${hiddenCount} mas`}</button>`;
                }
                ahtml += `</div>`;
                return ahtml;
            })() : ''}
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3">🏦 Cuenta Bancaria para Retiros</h3>
                ${hasBank ? `<div class="p-3 bg-gray rounded"><p class="text-sm"><strong>Banco:</strong> ${bankInfo.bank}</p><p class="text-sm"><strong>Cuenta:</strong> ${bankInfo.account}</p><p class="text-sm"><strong>Telefono:</strong> ${bankInfo.phone || '-'}</p><p class="text-sm"><strong>Titular:</strong> ${bankInfo.name || '-'}</p></div>` : '<p class="text-xs text-red mb-2">No tienes cuenta bancaria configurada.</p>'}
                <div class="mt-3">
                    <div class="form-group mb-2">
                        <select id="mensajero-wbank" class="input"><option value="">Selecciona banco</option>${BANKS.map(b => `<option value="${b.code}" ${bankInfo.bank === b.code ? 'selected' : ''}>${b.code} - ${b.name}</option>`).join('')}</select>
                    </div>
                    <div class="grid grid-2 gap-2 mb-2">
                        <input type="text" id="mensajero-waccount" class="input" placeholder="Nro. Cuenta" value="${bankInfo.account || ''}">
                        <input type="text" id="mensajero-wphone" class="input" placeholder="Telefono" value="${bankInfo.phone || ''}">
                    </div>
                    <input type="text" id="mensajero-wname" class="input mb-2" placeholder="Titular de la cuenta" value="${bankInfo.name || ''}">
                    <button onclick="App.saveMensajeroBankInfo()" class="btn btn-cyan w-full">Guardar Cuenta</button>
                </div>
            </div>
        `;
        walletEl.innerHTML = html;
    },

    async toggleMensajeroAvailability(checkbox) {
        await API.put(`/api/users/${this.session.id}`, { available: checkbox.checked });
        this.session.available = checkbox.checked;
        this.renderMensajeroDashboard();
    },

    async requestMensajeroWithdrawal() {
        const amount = parseFloat(document.getElementById('mensajero-withdraw-amount')?.value) || 0;
        if (amount <= 0 || amount > this.session.balance) { this.showToast('Monto invalido.', 'error'); return; }
        const result = await API.post('/api/wallet/withdraw', { conductorId: this.session.id, amount });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.showToast('Retiro solicitado. Pendiente de aprobacion.', 'success');
        this.session = await API.get(`/api/users/${this.session.id}`);
        this.renderMensajeroDashboard();
    },

    async saveMensajeroBankInfo() {
        const bank = document.getElementById('mensajero-wbank')?.value;
        const account = document.getElementById('mensajero-waccount')?.value;
        const phone = document.getElementById('mensajero-wphone')?.value;
        const name = document.getElementById('mensajero-wname')?.value;
        if (!bank || !account) { this.showToast('Banco y cuenta son requeridos.', 'error'); return; }
        await API.put(`/api/users/${this.session.id}`, { bankInfo: { bank, account, phone, name } });
        this.session = await API.get(`/api/users/${this.session.id}`);
        this.showToast('Cuenta bancaria guardada.', 'success');
        this.renderMensajeroDashboard();
    },

    async toggleAvailability(checkbox) {
        await API.put(`/api/users/${this.session.id}`, { available: checkbox.checked });
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.showToast(checkbox.checked ? 'Estas en linea y disponible.' : 'Has salido de linea.', checkbox.checked ? 'success' : 'warning');
        this.updateViewContent();
    },

    async acceptTripByConductor(tripId) {
        await API.put(`/api/trips/${tripId}/status`, { status: 'aceptado' });
        this.showToast('Servicio Aceptado!', 'success');
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.updateViewContent();
    },

    async rejectTripByConductor(tripId) {
        await API.put(`/api/trips/${tripId}/status`, { status: 'rechazado' });
        this.showToast('Servicio rechazado.', 'warning');
        this.updateViewContent();
    },

    async completeTripByConductor(tripId) {
        await API.put(`/api/trips/${tripId}/status`, { status: 'completado' });
        this.showToast('Viaje completado. Verifica el pago.', 'success');
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.updateViewContent();
    },

    async confirmPaymentByConductor(tripId) {
        await API.put(`/api/trips/${tripId}/status`, { status: 'pago_verificado' });
        this.showToast('Pago verificado. Califica al cliente.', 'success');
        this.updateViewContent();
    },

    toggleAdminSection(sectionId) {
        const el = document.getElementById(sectionId);
        if (!el) return;
        const isHidden = el.style.display === 'none';
        el.style.display = isHidden ? '' : 'none';
        const btn = document.getElementById(sectionId + '-toggle');
        if (btn) btn.textContent = isHidden ? '▲' : '▼';
    },

    async renderAdminDashboard() {
        let trips = [], users = [], transactions = [], config = {}, recharges = [], withdrawals = [];
        try {
            [trips, users, transactions, config, recharges, withdrawals] = await Promise.all([
                API.get('/api/trips'), API.get('/api/users'), API.get('/api/transactions'),
                API.get('/api/config'), API.get('/api/wallet/recharges').catch(() => []),
                API.get('/api/wallet/withdrawals').catch(() => [])
            ]);
        } catch(e) { this.showToast('Error cargando datos admin.', 'error'); return; }
        const completed = trips.filter(t => ['completado', 'calificado'].includes(t.status));
        const volume = completed.reduce((acc, t) => acc + t.price, 0);
        const commissionTrips = completed.reduce((acc, t) => acc + (t.platformCommission || 0), 0);
        const realizedWithdrawals = withdrawals.filter(w => w.status === 'realizado');
        const commissionWithdrawals = realizedWithdrawals.reduce((acc, w) => acc + (w.commission || 0), 0);
        const totalLiquidation = commissionTrips + commissionWithdrawals;
        const pendingRecharges = recharges.filter(r => r.status === 'pendiente').length;
        const pendingWithdrawals = withdrawals.filter(w => w.status === 'pendiente').length;

        document.getElementById('admin-stat-trips').textContent = trips.length;
        document.getElementById('admin-stat-completed').textContent = completed.length;
        document.getElementById('admin-stat-volume').innerHTML = `$${volume.toFixed(2)}<br><span class="text-xs text-gray">Bs ${this.toBs(volume)}</span>`;
        document.getElementById('admin-stat-commission-trips').innerHTML = `$${commissionTrips.toFixed(2)}<br><span class="text-xs text-gray">Bs ${this.toBs(commissionTrips)}</span>`;
        document.getElementById('admin-stat-commission-withdrawals').innerHTML = `$${commissionWithdrawals.toFixed(2)}<br><span class="text-xs text-gray">Bs ${this.toBs(commissionWithdrawals)}</span>`;
        document.getElementById('admin-stat-platform').innerHTML = `$${totalLiquidation.toFixed(2)}<br><span class="text-xs text-gray">Bs ${this.toBs(totalLiquidation)}</span>`;

        const pendingBadge = document.getElementById('admin-stat-pending');
        if (pendingBadge) pendingBadge.textContent = pendingRecharges + pendingWithdrawals;

        const bcvRateEl = document.getElementById('admin-bcv-rate');
        if (bcvRateEl) bcvRateEl.value = config.bcvRate || '36.50';

        const usersTable = document.getElementById('admin-users-list');
        let html = '<table class="table"><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Vehiculo</th><th>Billetera</th><th>2FA</th><th>Rating</th></tr></thead><tbody>';
        users.forEach(u => {
            const vIcons = { carro: '🚗', camioneta: '🚙', moto: '🏍️', moto_delivery: '🛵', mensajero: '🚶', mudanza_pickup: '🛻', mudanza_350: '🚛', mudanza_750: '🚚' };
            const vt = u.role === 'conductor' ? `${vIcons[u.vehicle?.type] || '🚗'} ${u.vehicle?.brand} ${u.vehicle?.model}` : '-';
            const avg = u.ratings?.length > 0 ? (u.ratings.reduce((a, b) => a + b, 0) / u.ratings.length).toFixed(1) : '-';
            const tfa = u.twoFactorEnabled ? '<span class="badge text-emerald">ON</span>' : '<span class="badge text-gray">OFF</span>';
            html += `<tr><td><strong>${u.name}</strong></td><td>${u.email}</td><td><span class="badge ${u.role === 'conductor' ? 'text-purple' : u.role === 'admin' ? 'text-red' : 'text-cyan'}">${u.role.toUpperCase()}</span></td><td>${vt}</td><td class="font-bold text-emerald">$${(u.balance || 0).toFixed(2)} <span class="text-xs text-gray">Bs ${this.toBs(u.balance || 0)}</span></td><td>${tfa}</td><td>${avg !== '-' ? this.renderStarsSmall(avg, u.ratings.length) : '-'}</td></tr>`;
        });
        html += '</tbody></table>';
        usersTable.innerHTML = html;

        const txnTable = document.getElementById('admin-transactions-list');
        if (txnTable) {
            if (transactions.length === 0) {
                txnTable.innerHTML = `<p class="text-center text-gray p-4">No hay transacciones.</p>`;
            } else {
                let txnHtml = '<table class="table"><thead><tr><th>ID</th><th>Cliente</th><th>Conductor</th><th>Monto</th><th>Metodo</th><th>Estado</th></tr></thead><tbody>';
                transactions.slice(0, 50).forEach(t => {
                    const cl = users.find(u => u.id === t.clientId);
                    const co = users.find(u => u.id === t.conductorId);
                    txnHtml += `<tr><td class="text-xs font-mono">${t.id.slice(-8)}</td><td><strong>${cl?.name || 'N/A'}</strong></td><td><strong>${co?.name || 'N/A'}</strong></td><td class="font-bold text-emerald">$${t.amount.toFixed(2)} <span class="text-xs text-gray">Bs ${this.toBs(t.amount)}</span></td><td><span class="badge ${t.method === 'rkm' ? 'text-emerald' : 'text-cyan'}">${t.method === 'rkm' ? 'RKM' : 'P.Movil'}</span></td><td class="text-emerald font-bold">${t.status.toUpperCase()}</td></tr>`;
                });
                txnHtml += '</tbody></table>';
                txnTable.innerHTML = txnHtml;
            }
        }

        const tripsList = document.getElementById('admin-trips-list');
        if (tripsList) {
            if (trips.length === 0) {
                tripsList.innerHTML = `<p class="text-center text-gray p-4">No hay viajes registrados.</p>`;
            } else {
                const defaultCount = 5;
                const sorted = [...trips].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
                const initial = sorted.slice(0, defaultCount);
                const hidden = sorted.slice(defaultCount);
                let tripHtml = '<table class="table"><thead><tr><th>Fecha</th><th>Cliente</th><th>Conductor</th><th>Ruta</th><th>Precio</th><th>Pago</th><th>Estado</th></tr></thead><tbody>';
                initial.forEach(t => {
                    const cl = users.find(u => u.id === t.clientId);
                    const co = users.find(u => u.id === t.conductorId);
                    const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '-';
                    const statusColors = { pendiente: 'text-yellow', aceptado: 'text-purple', completado: 'text-emerald', pago_verificado: 'text-cyan', calificado: 'text-emerald', rechazado: 'text-red' };
                    const sc = statusColors[t.status] || 'text-gray';
                    tripHtml += `<tr><td class="text-xs">${date}</td><td><strong>${cl?.name || t.clientName || 'N/A'}</strong></td><td><strong>${co?.name || t.conductorName || 'N/A'}</strong></td><td><span class="text-xs">${t.originAddress}</span> ➔ <span class="text-xs">${t.destinationAddress}</span></td><td class="font-bold text-emerald">$${t.price.toFixed(2)}</td><td><span class="badge ${t.paymentMethod === 'rkm' ? 'text-emerald' : t.paymentMethod === 'efectivo' ? 'text-yellow' : 'text-cyan'}">${t.paymentMethod === 'rkm' ? 'RKM' : t.paymentMethod === 'efectivo' ? 'Efectivo' : 'P.Movil'}</span></td><td class="${sc} font-bold text-xs">${t.status.toUpperCase()}</td></tr>`;
                });
                tripHtml += '</tbody></table>';
                if (hidden.length > 0) {
                    tripHtml += `<div id="admin-trips-extra" style="display:none"><table class="table"><tbody>`;
                    hidden.forEach(t => {
                        const cl = users.find(u => u.id === t.clientId);
                        const co = users.find(u => u.id === t.conductorId);
                        const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : '-';
                        const statusColors = { pendiente: 'text-yellow', aceptado: 'text-purple', completado: 'text-emerald', pago_verificado: 'text-cyan', calificado: 'text-emerald', rechazado: 'text-red' };
                        const sc = statusColors[t.status] || 'text-gray';
                        tripHtml += `<tr><td class="text-xs">${date}</td><td><strong>${cl?.name || t.clientName || 'N/A'}</strong></td><td><strong>${co?.name || t.conductorName || 'N/A'}</strong></td><td><span class="text-xs">${t.originAddress}</span> ➔ <span class="text-xs">${t.destinationAddress}</span></td><td class="font-bold text-emerald">$${t.price.toFixed(2)}</td><td><span class="badge ${t.paymentMethod === 'rkm' ? 'text-emerald' : t.paymentMethod === 'efectivo' ? 'text-yellow' : 'text-cyan'}">${t.paymentMethod === 'rkm' ? 'RKM' : t.paymentMethod === 'efectivo' ? 'Efectivo' : 'P.Movil'}</span></td><td class="${sc} font-bold text-xs">${t.status.toUpperCase()}</td></tr>`;
                    });
                    tripHtml += '</tbody></table></div>';
                    tripHtml += `<div class="text-center mt-2"><button id="admin-trips-toggle" onclick="App.toggleAdminSection('admin-trips-extra')" class="btn btn-sm btn-purple">▼ Mostrar ${hidden.length} viajes mas</button></div>`;
                }
                tripsList.innerHTML = tripHtml;
            }
        }

        const pendingPagos = document.getElementById('admin-pending-pagos');
        const pendingPMBadge = document.getElementById('admin-pending-pm');
        if (pendingPMBadge) pendingPMBadge.textContent = '0';
        if (pendingPagos) {
            pendingPagos.innerHTML = `<p class="text-center text-gray p-4">Los pagos movil ahora son directos. No requieren verificacion del admin.</p>`;
        }

        this.renderAdminBankConfig(config);

        try { await this.renderAdminSupport(recharges, withdrawals); } catch(e) { console.error('Support panel error:', e); }
        try { this.renderAdminBackup(); } catch(e) { console.error('Backup panel error:', e); }

        const reportDate = document.getElementById('admin-report-date');
        if (reportDate && !reportDate.value) reportDate.value = new Date().toISOString().slice(0, 10);
    },

    async generateDailyReport() {
        const date = document.getElementById('admin-report-date')?.value || new Date().toISOString().slice(0, 10);
        const container = document.getElementById('admin-daily-report');
        if (!container) return;
        container.innerHTML = `<p class="text-center text-cyan p-4">Generando reporte...</p>`;
        const report = await API.get(`/api/admin/daily-report?date=${date}`);
        BANK_NAMES_MAP;
        let html = `<div id="daily-report-content">`;
        html += `<div class="p-4 bg-gray rounded mb-4 text-center"><h3 class="font-bold text-purple text-lg">REPORTE DIARIO - ${date}</h3><p class="text-xs text-gray">Generado: ${new Date().toLocaleString()}</p></div>`;
        html += `<div class="grid grid-4 gap-3 mb-4">`;
        html += `<div class="p-3 bg-gray rounded text-center"><p class="text-xs text-gray">Viajes Totales</p><p class="text-xl font-extrabold text-purple">${report.totalTrips}</p></div>`;
        html += `<div class="p-3 bg-gray rounded text-center"><p class="text-xs text-gray">Completados</p><p class="text-xl font-extrabold text-emerald">${report.completedTrips}</p></div>`;
        html += `<div class="p-3 bg-gray rounded text-center"><p class="text-xs text-gray">Volumen Total</p><p class="text-xl font-extrabold text-cyan">$${report.totalVolume.toFixed(2)}</p></div>`;
        html += `<div class="p-3 bg-gray rounded text-center"><p class="text-xs text-gray">Comision Plataforma</p><p class="text-xl font-extrabold text-yellow">$${report.totalCommission.toFixed(2)}</p></div>`;
        html += `</div>`;
        if (report.pendingPayments > 0) {
            html += `<div class="p-3 bg-dark rounded border-l-yellow mb-4"><p class="text-xs text-yellow font-bold">⚠️ ${report.pendingPayments} pago(s) movil pendiente(s) de verificacion</p></div>`;
        }
        html += `<h3 class="font-bold text-purple mb-3">📋 Resumen por Tipo de Servicio</h3>`;
        html += `<table class="table mb-4"><thead><tr><th>Tipo</th><th>Viajes</th><th>Volumen</th><th>Comision</th><th>Porcentaje</th></tr></thead><tbody>`;
        Object.entries(report.byVehicleType).forEach(([type, data]) => {
            const pct = report.totalVolume > 0 ? ((data.totalVolume / report.totalVolume) * 100).toFixed(1) : 0;
            html += `<tr><td><strong>${type}</strong></td><td>${data.count}</td><td class="font-bold text-emerald">$${data.totalVolume.toFixed(2)}</td><td class="font-bold text-yellow">$${data.totalCommission.toFixed(2)}</td><td>${pct}%</td></tr>`;
        });
        html += `<tr class="font-bold" style="background:rgba(139,92,246,0.1)"><td>TOTAL</td><td>${report.totalTrips}</td><td class="text-emerald">$${report.totalVolume.toFixed(2)}</td><td class="text-yellow">$${report.totalCommission.toFixed(2)}</td><td>100%</td></tr>`;
        html += `</tbody></table>`;
        if (report.trips && report.trips.length > 0) {
            html += `<h3 class="font-bold text-purple mb-3">📝 Detalle de Viajes</h3>`;
            report.trips.forEach(t => {
                const statusColors = { completado: 'text-emerald', pago_verificado: 'text-cyan', calificado: 'text-purple', rechazado: 'text-red', pendiente: 'text-yellow', aceptado: 'text-purple' };
                const sc = statusColors[t.status] || 'text-gray';
                html += `<div class="p-3 bg-gray rounded mb-2"><div class="flex justify-between items-start"><div><p class="text-xs"><strong>${t.clientName || 'N/A'}</strong> → <strong>${t.conductorName || 'N/A'}</strong></p><p class="text-xs text-gray">${t.originAddress} → ${t.destinationAddress} | ${t.distance?.toFixed(1) || 0}km</p></div><div class="text-right"><p class="font-bold text-emerald">$${t.price.toFixed(2)}</p><p class="text-xs ${sc}">${t.status.toUpperCase()}</p></div></div>`;
                if (t.platformCommission > 0) {
                    html += `<p class="text-xs text-yellow mt-1">Comision: $${t.platformCommission.toFixed(2)}</p>`;
                }
                html += `</div>`;
            });
        }
        if (report.withdrawals && report.withdrawals.length > 0) {
            html += `<h3 class="font-bold text-purple mb-3">💸 Retiros del Dia (${report.withdrawals.length})</h3>`;
            html += `<table class="table mb-4"><thead><tr><th>Conductor</th><th>Monto</th><th>Comision</th><th>Neto</th><th>Estado</th></tr></thead><tbody>`;
            report.withdrawals.forEach(w => {
                const sc = w.status === 'aprobada' ? 'text-emerald' : w.status === 'realizado' ? 'text-purple' : w.status === 'rechazada' ? 'text-red' : 'text-cyan';
                html += `<tr><td><strong>${w.conductorName || '-'}</strong></td><td>$${w.amount.toFixed(2)}</td><td>$${(w.commission || 0).toFixed(2)}</td><td class="font-bold text-emerald">$${(w.netAmount || w.amount).toFixed(2)}</td><td class="${sc} font-bold">${w.status.toUpperCase()}</td></tr>`;
            });
            html += `</tbody></table>`;
        }
        html += `</div>`;
        container.innerHTML = html;
    },

    printDailyReport() {
        const content = document.getElementById('daily-report-content');
        if (!content) { this.showToast('Genera el reporte primero.', 'warning'); return; }
        const win = window.open('', '_blank');
        win.document.write('<html><head><title>Reporte Diario TuRides</title><style>body{font-family:Arial,sans-serif;padding:20px;font-size:12px}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#8b5cf6;color:white}tr:nth-child(even){background:#f9f9f9}.grid{display:grid;gap:10px}.grid-4{grid-template-columns:repeat(4,1fr)}.text-center{text-align:center}.font-bold{font-weight:bold}.text-emerald{color:#10b981}.text-yellow{color:#f59e0b}.text-purple{color:#8b5cf6}.text-cyan{color:#06b6d4}.text-gray{color:#999}.text-xl{font-size:1.2rem}.text-xs{font-size:0.7rem}.bg-gray{background:#1a1a2e;padding:10px;border-radius:8px;margin-bottom:8px}.bg-dark{background:#111;padding:10px;border-radius:8px}.p-3{padding:12px}.mb-4{margin-bottom:16px}.rounded{border-radius:8px}</style></head><body>');
        win.document.write(content.innerHTML);
        win.document.write('</body></html>');
        win.document.close();
        win.print();
    },

    async adminVerifyPagoMovil(tripId) {
        if (!confirm('Confirmar que el pago movil fue recibido correctamente?')) return;
        try {
            await API.put(`/api/admin/verify-pago-movil/${tripId}`);
            this.showToast('Pago verificado. Saldo del conductor actualizado.', 'success');
            this.renderAdminDashboard();
        } catch(e) {
            this.showToast('Error verificando pago.', 'error');
        }
    },

    async adminVerifyPass(purchaseId, action) {
        const msg = action === 'approve' ? 'aprobar' : 'rechazar';
        if (!confirm(`¿Confirmar ${msg} este PASS?`)) return;
        try {
            await API.put(`/api/admin/pass-verify/${purchaseId}`, { action });
            this.showToast(`PASS ${action === 'approve' ? 'aprobado' : 'rechazado'} exitosamente.`, 'success');
            this.renderAdminDashboard();
        } catch(e) {
            this.showToast('Error verificando PASS.', 'error');
        }
    },

    async renderAdminSupport(recharges, withdrawals) {
        const container = document.getElementById('admin-support-panel');
        if (!container) return;

        let html = '';

        html += `<div class="mb-6"><h3 class="text-lg font-bold mb-3 text-cyan" style="cursor:pointer" onclick="App.toggleAdminSection('admin-recharges-body')"><span id="admin-recharges-body-toggle">▲</span> 📥 Recargas de Clientes (${recharges.length})</h3>`;
        html += `<div id="admin-recharges-body">`;
        if (recharges.length === 0) {
            html += `<p class="text-center text-gray p-4">No hay solicitudes de recarga.</p>`;
        } else {
            const defaultCount = 5;
            const sorted = [...recharges].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const initial = sorted.slice(0, defaultCount);
            const hidden = sorted.slice(defaultCount);
            html += '<table class="table"><thead><tr><th>ID</th><th>Cliente</th><th>Monto</th><th>Banco</th><th>Ref</th><th>Estado</th><th>Accion</th></tr></thead><tbody>';
            const renderRechargeRow = (r) => {
                const statusColor = r.status === 'aprobada' ? 'text-emerald' : r.status === 'rechazada' ? 'text-red' : 'text-cyan';
                return `<tr>
                    <td class="text-xs font-mono">${r.id.slice(-8)}</td>
                    <td><strong>${r.userName}</strong></td>
                    <td class="font-bold text-emerald">$${r.amount.toFixed(2)} <span class="text-xs">Bs ${this.toBs(r.amount)}</span></td>
                    <td class="text-xs">${r.bankCode || '-'}</td>
                    <td class="text-xs font-mono">${r.reference || '-'}</td>
                    <td><span class="badge ${statusColor}">${r.status.toUpperCase()}</span></td>
                    <td>${r.status === 'pendiente' ? `<div class="flex gap-1"><button onclick="App.adminReviewRecharge('${r.id}', 'aprobada')" class="btn btn-emerald btn-sm">✓</button><button onclick="App.adminReviewRecharge('${r.id}', 'rechazada')" class="btn btn-red btn-sm">✗</button></div>` : '<span class="text-xs text-gray">' + (r.adminNote || 'Revisado') + '</span>'}</td>
                </tr>`;
            };
            initial.forEach(r => { html += renderRechargeRow(r); });
            html += '</tbody></table>';
            if (hidden.length > 0) {
                html += `<div id="admin-recharges-extra" style="display:none"><table class="table"><tbody>`;
                hidden.forEach(r => { html += renderRechargeRow(r); });
                html += '</tbody></table></div>';
                html += `<div class="text-center mt-2"><button id="admin-recharges-extra-toggle" onclick="App.toggleAdminSection('admin-recharges-extra')" class="btn btn-sm btn-purple">▼ Mostrar ${hidden.length} recargas mas</button></div>`;
            }
        }
        html += `</div></div>`;

        html += `<div><h3 class="text-lg font-bold mb-3 text-purple" style="cursor:pointer" onclick="App.toggleAdminSection('admin-withdrawals-body')"><span id="admin-withdrawals-body-toggle">▲</span> 📤 Retiros de Conductores (${withdrawals.length})</h3>`;
        html += `<div id="admin-withdrawals-body">`;
        if (withdrawals.length === 0) {
            html += `<p class="text-center text-gray p-4">No hay solicitudes de retiro.</p>`;
        } else {
            const defaultCount = 5;
            BANK_NAMES_MAP;
            const sorted = [...withdrawals].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const initial = sorted.slice(0, defaultCount);
            const hidden = sorted.slice(defaultCount);
            const renderWithdrawalCard = (w) => {
                const statusColor = w.status === 'aprobada' ? 'text-emerald' : w.status === 'rechazada' ? 'text-red' : w.status === 'realizado' ? 'text-purple' : 'text-cyan';
                const bInfo = JSON.parse(w.bankInfo || '{}');
                const bankName = BANK_NAMES_MAP[bInfo.bank] || bInfo.bank || '-';
                const commission = w.commission || 0;
                const netAmount = w.netAmount || (w.amount - commission);
                return `<div class="glass-card mb-3 p-4 border-l-purple">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <h4 class="font-bold text-purple">${w.conductorName}</h4>
                            <p class="text-xs text-gray">Solicitud: ${w.id}</p>
                        </div>
                        <span class="badge ${statusColor}">${w.status.toUpperCase()}</span>
                    </div>
                    <div class="p-3 bg-gray rounded mb-3">
                        <p class="text-xs text-gray font-bold mb-2">RESUMEN DEL RETIRO:</p>
                        <div class="flex justify-between text-sm mb-1"><span>Monto solicitado:</span><span class="font-bold">$${w.amount.toFixed(2)} <span class="text-xs text-gray">Bs ${w.amountBs}</span></span></div>
                        <div class="flex justify-between text-sm mb-1 text-red"><span>Comision (${this._bcvRate ? '10' : '10'}%):</span><span class="font-bold">-$${commission.toFixed(2)}</span></div>
                        <hr class="border-gray my-1">
                        <div class="flex justify-between text-sm font-bold"><span>Monto a transferir:</span><span class="text-emerald text-lg">$${netAmount.toFixed(2)}</span></div>
                    </div>
                    <div class="grid grid-2 gap-2 mb-2 text-xs">
                        <div class="p-2 bg-gray rounded"><span class="text-gray">Cuenta destino:</span><br><strong>${bankName}</strong><br><span class="font-mono">${bInfo.account || '-'}</span></div>
                        <div class="p-2 bg-gray rounded"><span class="text-gray">Titular:</span><br><strong>${bInfo.name || '-'}</strong><br><span class="text-gray">Tel: ${bInfo.phone || '-'}</span></div>
                    </div>
                    <div class="p-2 bg-gray rounded mb-2 text-xs">
                        <span class="text-gray">Fecha:</span> <strong>${w.createdAt ? new Date(w.createdAt).toLocaleString() : '-'}</strong>
                        ${w.reviewedAt ? `<span class="ml-3 text-gray">Revisado:</span> <strong>${new Date(w.reviewedAt).toLocaleString()}</strong>` : ''}
                        ${w.reference ? `<span class="ml-3 text-cyan">Ref:</span> <strong>${w.reference}</strong>` : ''}
                    </div>
                    ${w.status === 'pendiente' ? `<div class="flex gap-2 mt-3"><button onclick="App.adminApproveWithdrawal('${w.id}')" class="btn btn-emerald flex-1">✓ Aprobar</button><button onclick="App.adminReviewWithdrawal('${w.id}', 'rechazada')" class="btn btn-red flex-1">✗ Rechazar</button></div>` : ''}
                    ${w.status === 'aprobada' ? `<div class="mt-3"><p class="text-xs text-cyan font-bold mb-2">Transferir $${netAmount.toFixed(2)} a la cuenta del conductor y luego confirmar:</p><div class="form-group mb-2"><input type="text" id="wdr-ref-${w.id}" class="input" placeholder="Referencia de la transferencia bancaria"></div><div class="flex gap-2"><button onclick="App.adminRealizeWithdrawal('${w.id}')" class="btn btn-purple flex-1">✓ Transferencia Realizada</button></div></div>` : ''}
                    ${w.status === 'realizado' ? `<div class="mt-2 p-2 bg-emerald rounded text-xs"><p class="font-bold text-emerald">✅ Transferencia realizada</p><p>Ref: <strong>${w.reference || '-'}</strong></p><div class="mt-2"><a href="/api/wallet/withdrawals/${w.id}/ticket" target="_blank" class="btn btn-purple btn-sm" style="font-size:10px;padding:4px 8px;">📄 Ver Ticket PDF</a></div></div>` : ''}
                    ${w.status === 'rechazada' ? `<div class="mt-2 text-xs text-gray">${w.adminNote ? `<strong>Motivo:</strong> ${w.adminNote}` : 'Rechazado'}</div>` : ''}
                </div>`;
            };
            initial.forEach(w => { html += renderWithdrawalCard(w); });
            if (hidden.length > 0) {
                html += `<div id="admin-withdrawals-extra" style="display:none">`;
                hidden.forEach(w => { html += renderWithdrawalCard(w); });
                html += `</div>`;
                html += `<div class="text-center mt-2"><button id="admin-withdrawals-extra-toggle" onclick="App.toggleAdminSection('admin-withdrawals-extra')" class="btn btn-sm btn-purple">▼ Mostrar ${hidden.length} retiros mas</button></div>`;
            }
        }
        html += `</div></div>`;

        html += `<div class="mt-4"><h3 class="text-lg font-bold mb-3 text-yellow" style="cursor:pointer" onclick="App.toggleAdminSection('admin-pass-body')"><span id="admin-pass-body-toggle">▲</span> 🎫 PASS Pendientes de Verificacion</h3>`;
        html += `<div id="admin-pass-body">`;
        try {
            const pendingPasses = await API.get('/api/admin/pass-pending');
            if (pendingPasses.length === 0) {
                html += `<p class="text-center text-gray p-4">No hay PASS pendientes de verificacion.</p>`;
            } else {
                pendingPasses.forEach(p => {
                    const ptier = PASS_TIERS_CONFIG[p.passLevel];
                    html += `<div class="glass-card mb-3 p-4 border-l-yellow">
                        <div class="flex justify-between items-start mb-2">
                            <div>
                                <h4 class="font-bold text-yellow">PASS ${ptier ? ptier.label : p.passLevel}</h4>
                                <p class="text-xs text-gray">Conductor: <strong>${p.userName}</strong></p>
                                <p class="text-xs text-gray">ID: ${p.id}</p>
                            </div>
                            <span class="text-lg font-extrabold text-emerald">$${p.amount.toFixed(2)}</span>
                        </div>
                        <div class="p-2 bg-gray rounded mb-2 text-xs">
                            <span class="text-gray">Metodo:</span> <strong class="text-cyan">Pago Movil</strong> |
                            <span class="text-gray">Fecha:</span> <strong>${p.createdAt ? new Date(p.createdAt).toLocaleString() : '-'}</strong>
                        </div>
                        <div class="flex gap-2 mt-3">
                            <button onclick="App.adminVerifyPass('${p.id}', 'approve')" class="btn btn-emerald flex-1">✓ Aprobar PASS</button>
                            <button onclick="App.adminVerifyPass('${p.id}', 'reject')" class="btn btn-red flex-1">✗ Rechazar</button>
                        </div>
                    </div>`;
                });
            }
        } catch(e) {
            html += `<p class="text-center text-red p-4">Error cargando PASS pendientes.</p>`;
        }
        html += `</div></div>`;

        container.innerHTML = html;
    },

    async renderAdminBackup() {
        const container = document.getElementById('admin-backup-panel');
        if (!container) return;
        let reminderHtml = '';
        try {
            const status = await API.get('/api/admin/backup/status');
            if (status.needsBackup) {
                const msg = status.daysSince === null ? 'Nunca has creado un backup.' : `Ultimo backup hace ${status.daysSince} dias.`;
                reminderHtml = `<div class="glass-card p-4 mb-4" style="border: 2px solid #f59e0b; background: rgba(245, 158, 11, 0.1);">
                    <div class="flex items-center gap-3">
                        <span style="font-size: 2rem;">⚠️</span>
                        <div>
                            <p class="font-bold text-sm" style="color: #f59e0b;">RECORDATORIO DE BACKUP</p>
                            <p class="text-xs">${msg} Te recomiendo descargar uno ahora.</p>
                        </div>
                    </div>
                </div>`;
            }
        } catch(e) {}
        container.innerHTML = `
            ${reminderHtml}
            <div class="mb-4">
                <h3 class="text-lg font-bold mb-3 text-cyan">💾 Backup y Restauracion</h3>
                <div class="grid grid-3 gap-2">
                    <div class="glass-card p-4 text-center">
                        <p class="text-sm mb-3">Exportar todos los datos como archivo JSON a tu computadora.</p>
                        <button onclick="App.adminBackup()" class="btn btn-purple w-full">📦 Descargar Backup</button>
                    </div>
                    <div class="glass-card p-4 text-center">
                        <p class="text-sm mb-3">Subir backup automaticamente a Google Drive.</p>
                        <button onclick="App.adminBackupGoogleDrive()" class="btn btn-emerald w-full">☁️ Subir a Google Drive</button>
                    </div>
                    <div class="glass-card p-4 text-center">
                        <p class="text-sm mb-3">Restaurar datos desde un archivo JSON de backup anterior.</p>
                        <input type="file" id="restore-file" accept=".json" style="display:none" onchange="App.adminRestoreFile(event)">
                        <button onclick="document.getElementById('restore-file').click()" class="btn btn-cyan w-full">📥 Restaurar Backup</button>
                    </div>
                </div>
            </div>`;
    },

    async adminBackup() {
        try {
            this.showToast('Generando backup...', 'info');
            const res = await fetch('/api/admin/backup', { headers: { 'x-user-id': this.session.id } });
            if (!res.ok) throw new Error('Error al crear backup');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `turides-backup-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            await fetch('/api/admin/backup/track', { method: 'POST', headers: { 'x-user-id': this.session.id } });
            this.showToast('Backup descargado exitosamente.', 'success');
            this.renderAdminBackup();
        } catch (e) {
            this.showToast('Error: ' + e.message, 'error');
        }
    },

    async adminBackupGoogleDrive() {
        try {
            this.showToast('Subiendo backup a Google Drive...', 'info');
            const res = await fetch('/api/admin/backup/google-drive', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': this.session.id }
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Error al subir');
            this.showToast(`Backup subido a Google Drive: ${result.fileName}`, 'success');
            this.renderAdminBackup();
        } catch (e) {
            this.showToast('Error: ' + e.message, 'error');
        }
    },

    async adminRestoreFile(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (!confirm('⚠️ Esto REEMPLAZARÁ todos los datos actuales. ¿Estás seguro?')) return;
        try {
            this.showToast('Restaurando backup...', 'info');
            const text = await file.text();
            const backup = JSON.parse(text);
            const res = await fetch('/api/admin/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-user-id': this.session.id },
                body: text
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Error al restaurar');
            this.showToast(`Restaurado: ${result.users} usuarios, ${result.trips} viajes.`, 'success');
            this.renderAdminDashboard();
        } catch (e) {
            this.showToast('Error: ' + e.message, 'error');
        }
        event.target.value = '';
    },

    async adminReviewRecharge(id, status) {
        const note = status === 'rechazada' ? prompt('Motivo del rechazo (opcional):') || '' : '';
        await API.put(`/api/wallet/recharges/${id}`, { status, adminNote: note });
        this.showToast(`Recarga ${status}.`, 'success');
        this.renderAdminDashboard();
    },

    async adminReviewWithdrawal(id, status) {
        const note = status === 'rechazada' ? prompt('Motivo del rechazo (opcional):') || '' : '';
        await API.put(`/api/wallet/withdrawals/${id}`, { status, adminNote: note });
        this.showToast(`Retiro ${status}.`, 'success');
        this.renderAdminDashboard();
    },

    async adminApproveWithdrawal(id) {
        await API.put(`/api/wallet/withdrawals/${id}`, { status: 'aprobada', adminNote: 'Aprobado por administrador' });
        this.showToast('Retiro aprobado. Ahora realiza la transferencia y confirma.', 'success');
        this.renderAdminDashboard();
    },

    async adminRealizeWithdrawal(id) {
        const ref = document.getElementById(`wdr-ref-${id}`)?.value?.trim();
        if (!ref) { this.showToast('Ingresa la referencia de la transferencia.', 'error'); return; }
        await API.put(`/api/wallet/withdrawals/${id}`, { status: 'realizado', reference: ref, adminNote: 'Transferencia bancaria realizada' });
        this.showToast('Transferencia registrada. El conductor ha sido notificado.', 'success');
        this.renderAdminDashboard();
    },

    async adminUpdateBCV() {
        const rate = parseFloat(document.getElementById('admin-bcv-rate').value);
        if (isNaN(rate) || rate <= 0) { this.showToast('Tasa BCV invalida.', 'error'); return; }
        await API.put('/api/config', { bcvRate: String(rate), bcvLastUpdate: new Date().toISOString() });
        this._bcvRate = rate;
        this.showToast(`Tasa BCV actualizada a ${rate}.`, 'success');
        this.renderNavbar();
        this.renderAdminDashboard();
    },

    async renderClientSettings() {
        const config = await API.get('/api/config');
        const settingsEl = document.getElementById('client-settings-panel');
        if (!settingsEl) return;

        const recharges = await API.get('/api/wallet/recharges');
        const myRecharges = recharges.filter(r => r.userId === this.session.id);

        let html = `
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3">💰 Recargar Billetera TuRides</h3>
                <p class="text-xs text-gray mb-3">Realiza un Pago Movil a la cuenta de TuRides y envia la solicitud de recarga.</p>
                <div class="pm-account-info mb-3">
                    <div class="pm-info-row"><span>Banco:</span><strong>${config.bankName}</strong></div>
                    <div class="pm-info-row"><span>Cuenta:</span><strong>${config.accountNumber}</strong></div>
                    <div class="pm-info-row"><span>Titular:</span><strong>${config.holderName}</strong></div>
                    <div class="pm-info-row"><span>RIF/Cedula:</span><strong>${config.documentType}-${config.documentNumber}</strong></div>
                    <div class="pm-info-row"><span>Tasa BCV:</span><strong class="text-cyan">${this._bcvRate} Bs/$</strong></div>
                </div>
                <div class="form-group">
                    <label>Monto a recargar ($)</label>
                    <input type="number" id="settings-recharge-amount" min="1" step="0.01" placeholder="Ej. 50.00" class="input">
                </div>
                <div class="form-group">
                    <label>Tu telefono</label>
                    <input type="tel" id="settings-recharge-phone" placeholder="0412-0000000" class="input" value="${this.session.phone || ''}">
                </div>
                <div class="form-group">
                    <label>Banco de origen</label>
                    <select id="settings-recharge-bank" class="input">
                        <option value="">Seleccionar banco</option>
                        ${BANKS.map(b => `<option value="${b.code}">${b.code} - ${b.name}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Referencia (6 digitos)</label>
                    <input type="text" id="settings-recharge-ref" placeholder="Ej. 123456" maxlength="6" class="input">
                </div>
                <button onclick="App.submitRecharge()" class="btn btn-emerald w-full">Enviar Solicitud de Recarga</button>
            </div>
            <div class="glass-card">
                <h3 class="text-lg font-bold mb-3" style="cursor:pointer" onclick="App.toggleAdminSection('client-recharges-body')"><span id="client-recharges-body-toggle">▲</span> 📋 Mis Recargas</h3>
                <div id="client-recharges-body">`;
        if (myRecharges.length === 0) {
            html += `<p class="text-center text-gray p-4">No tienes recargas registradas.</p>`;
        } else {
            const defaultCount = 5;
            const sorted = [...myRecharges].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            const initial = sorted.slice(0, defaultCount);
            const hidden = sorted.slice(defaultCount);
            html += '<table class="table"><thead><tr><th>Monto</th><th>Ref</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>';
            const renderRechargeRow = (r) => {
                const sc = r.status === 'aprobada' ? 'text-emerald' : r.status === 'rechazada' ? 'text-red' : 'text-cyan';
                const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '-';
                return `<tr><td class="font-bold text-emerald">$${r.amount.toFixed(2)} <span class="text-xs">Bs ${this.toBs(r.amount)}</span></td><td class="text-xs font-mono">${r.reference || '-'}</td><td><span class="badge ${sc}">${r.status.toUpperCase()}</span></td><td class="text-xs">${date}</td></tr>`;
            };
            initial.forEach(r => { html += renderRechargeRow(r); });
            html += '</tbody></table>';
            if (hidden.length > 0) {
                html += `<div id="client-recharges-extra" style="display:none"><table class="table"><tbody>`;
                hidden.forEach(r => { html += renderRechargeRow(r); });
                html += '</tbody></table></div>';
                html += `<div class="text-center mt-2"><button onclick="App.toggleAdminSection('client-recharges-extra')" class="btn btn-sm btn-purple" id="client-recharges-extra-toggle">▼ Mostrar ${hidden.length} recargas mas</button></div>`;
            }
        }
        html += `</div></div>`;

        html += `
            <div class="glass-card mt-4">
                <h3 class="text-lg font-bold mb-3">🔐 Seguridad de mi Cuenta</h3>
                <p class="text-xs text-gray mb-3">Cambiar contraseña y configurar autenticación de dos factores.</p>
                <div class="form-group">
                    <label>Contraseña Actual</label>
                    <input type="password" id="sec-current-pw" class="input" placeholder="Tu contraseña actual">
                </div>
                <div class="form-group">
                    <label>Nueva Contraseña</label>
                    <input type="password" id="sec-new-pw" class="input" placeholder="Mínimo 3 caracteres">
                </div>
                <div class="form-group">
                    <label>Confirmar Nueva Contraseña</label>
                    <input type="password" id="sec-confirm-pw" class="input" placeholder="Repite la nueva contraseña">
                </div>
                <button onclick="App.changePassword()" class="btn btn-purple w-full">Cambiar Contraseña</button>
                <hr class="my-4 border-gray">
                <div id="twofa-status-panel"></div>
            </div>`;

        settingsEl.innerHTML = html;
        this.renderTwoFactorStatus();
    },

    async submitRecharge() {
        const amount = parseFloat(document.getElementById('settings-recharge-amount').value);
        const phone = document.getElementById('settings-recharge-phone').value.trim();
        const bankCode = document.getElementById('settings-recharge-bank').value;
        const reference = document.getElementById('settings-recharge-ref').value.trim();
        if (isNaN(amount) || amount <= 0) { this.showToast('Ingresa un monto valido.', 'error'); return; }
        if (!phone || phone.length < 10) { this.showToast('Telefono invalido.', 'error'); return; }
        if (!bankCode) { this.showToast('Selecciona un banco.', 'error'); return; }
        if (!reference || reference.length < 6) { this.showToast('Referencia invalida (min 6 digitos).', 'error'); return; }
        const result = await API.post('/api/wallet/recharge', { userId: this.session.id, amount, phone, bankCode, reference });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.showToast(result.message || 'Recarga enviada.', 'success');
        this.renderClientSettings();
    },

    openRatingModal(tripId, targetId, targetName, role) {
        this._ratingTripId = tripId; this._ratingTargetId = targetId; this._ratingTargetName = targetName; this._ratingRole = role; this._selectedRating = 0;
        document.getElementById('rating-user-name').textContent = targetName;
        document.getElementById('rating-title').textContent = role === 'conductor' ? 'Califica al Cliente' : 'Califica al Conductor';
        document.getElementById('rating-subtitle').textContent = 'Como fue tu experiencia?';
        this.updateRatingStars(0);
        document.getElementById('rating-modal').classList.remove('hidden');
    },

    closeRatingModal() { document.getElementById('rating-modal').classList.add('hidden'); this._selectedRating = 0; },
    setRating(stars) { this._selectedRating = stars; this.updateRatingStars(stars); },

    updateRatingStars(active) {
        for (let i = 1; i <= 5; i++) { document.getElementById(`rating-star-${i}`)?.classList.toggle('active', i <= active); }
        const labels = ['', 'Malo', 'Regular', 'Bueno', 'Muy Bueno', 'Excelente'];
        document.getElementById('rating-label').textContent = labels[active] || '';
    },

    async submitRating() {
        if (this._selectedRating === 0) { this.showToast('Selecciona una calificacion.', 'warning'); return; }
        const field = this._ratingRole === 'conductor' ? 'conductorRating' : 'clientRating';
        await API.put(`/api/trips/${this._ratingTripId}/rating`, { field, value: this._selectedRating });
        this.showToast(`Calificaste con ${this._selectedRating} estrella(s).`, 'success');
        this.closeRatingModal();
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.updateViewContent();
        this.renderNavbar();
    },

    renderStarsSmall(avg, count) {
        if (!avg || count === 0) return '<span class="text-xs text-gray">Sin calificaciones</span>';
        const full = Math.floor(parseFloat(avg));
        const half = parseFloat(avg) - full >= 0.3;
        let h = '<span class="stars-display">';
        for (let i = 1; i <= 5; i++) { h += i <= full ? '<span class="star-filled">★</span>' : i === full + 1 && half ? '<span class="star-half">★</span>' : '<span class="star-empty">★</span>'; }
        return h + `</span> <span class="text-xs text-gray">(${avg} · ${count})</span>`;
    },

    renderAdminBankConfig(config) {
        const container = document.getElementById('admin-bank-config');
        if (!container) return;

        const bankOptions = BANKS.map(b => `<option value="${b.code}" ${config.bankName === b.name ? 'selected' : ''}>${b.code} - ${b.name}</option>`).join('');

        container.innerHTML = `
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3">🏦 Datos Bancarios para Recargas (TuRides)</h3>
                <p class="text-xs text-gray mb-3">Configura los datos que verán los clientes al recargar su billetera.</p>
                <div class="form-group">
                    <label>Banco</label>
                    <select id="admin-cfg-bank" class="input">${bankOptions}</select>
                </div>
                <div class="form-group">
                    <label>Número de Cuenta</label>
                    <input type="text" id="admin-cfg-account" class="input" value="${config.accountNumber || ''}" placeholder="0102-0000-0000-0000-0000">
                </div>
                <div class="form-group">
                    <label>Titular</label>
                    <input type="text" id="admin-cfg-holder" class="input" value="${config.holderName || ''}" placeholder="TuRides C.A.">
                </div>
                <div class="grid grid-2 gap-3">
                    <div class="form-group">
                        <label>Tipo Documento</label>
                        <select id="admin-cfg-doctype" class="input">
                            <option value="V" ${config.documentType === 'V' ? 'selected' : ''}>V</option>
                            <option value="E" ${config.documentType === 'E' ? 'selected' : ''}>E</option>
                            <option value="J" ${config.documentType === 'J' ? 'selected' : ''}>J</option>
                            <option value="G" ${config.documentType === 'G' ? 'selected' : ''}>G</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Número Documento</label>
                        <input type="text" id="admin-cfg-docnum" class="input" value="${config.documentNumber || ''}" placeholder="00000000">
                    </div>
                </div>
                <div class="form-group">
                    <label>Teléfono de Contacto</label>
                    <input type="tel" id="admin-cfg-phone" class="input" value="${config.phone || ''}" placeholder="0412-0000000">
                </div>
                <button onclick="App.adminSaveBankConfig()" class="btn btn-purple w-full mt-2">Guardar Datos Bancarios</button>
            </div>
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3">💸 Comisión por Retiro de Conductores</h3>
                <p class="text-xs text-gray mb-3">Porcentaje que TuRides cobra por cada retiro de conductor.</p>
                <div class="form-group">
                    <label>Comisión (%)</label>
                    <input type="number" id="admin-cfg-commission" class="input" value="${config.withdrawalCommission || '10'}" min="0" max="50" step="0.5" placeholder="10">
                </div>
                <p class="text-xs text-gray">Ejemplo: Si un conductor retira $100 con 10% de comisión, recibe $90.</p>
                <button onclick="App.adminSaveCommission()" class="btn btn-purple w-full mt-2">Guardar Comisión</button>
            </div>
            <div class="glass-card">
                <h3 class="text-lg font-bold mb-3">🔐 Seguridad de mi Cuenta</h3>
                <p class="text-xs text-gray mb-3">Cambiar contraseña y configurar autenticación de dos factores.</p>
                <div class="form-group">
                    <label>Contraseña Actual</label>
                    <input type="password" id="sec-current-pw" class="input" placeholder="Tu contraseña actual">
                </div>
                <div class="form-group">
                    <label>Nueva Contraseña</label>
                    <input type="password" id="sec-new-pw" class="input" placeholder="Mínimo 4 caracteres">
                </div>
                <div class="form-group">
                    <label>Confirmar Nueva Contraseña</label>
                    <input type="password" id="sec-confirm-pw" class="input" placeholder="Repite la nueva contraseña">
                </div>
                <button onclick="App.changePassword()" class="btn btn-purple w-full">Cambiar Contraseña</button>
                <hr class="my-4 border-gray">
                <div id="twofa-status-panel"></div>
            </div>`;
        this.renderTwoFactorStatus();
    },

    async renderTwoFactorStatus() {
        const panel = document.getElementById('twofa-status-panel');
        if (!panel || !this.session) return;
        const user = await API.get(`/api/users/${this.session.id}`);
        if (user.twoFactorEnabled) {
            panel.innerHTML = `
                <div class="flex items-center justify-between mb-3">
                    <div>
                        <p class="font-bold text-emerald">2FA Activo</p>
                        <p class="text-xs text-gray">Tu cuenta tiene autenticación de dos factores habilitada.</p>
                    </div>
                    <span class="badge text-emerald">✓ ACTIVO</span>
                </div>
                <div class="form-group">
                    <label>Contraseña para desactivar 2FA</label>
                    <input type="password" id="twofa-disable-pw" class="input" placeholder="Tu contraseña actual">
                </div>
                <button onclick="App.disable2FA()" class="btn btn-red w-full">Desactivar 2FA</button>`;
        } else {
            panel.innerHTML = `
                <div class="flex items-center justify-between mb-3">
                    <div>
                        <p class="font-bold text-cyan">2FA Inactivo</p>
                        <p class="text-xs text-gray">Protege tu cuenta con autenticación de dos factores (Authy, Google Authenticator).</p>
                    </div>
                    <span class="badge text-gray">INACTIVO</span>
                </div>
                <button onclick="App.setup2FA()" class="btn btn-emerald w-full">Activar 2FA</button>`;
        }
    },

    async setup2FA() {
        const result = await API.post('/api/2fa/setup', { userId: this.session.id });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        const panel = document.getElementById('twofa-status-panel');
        if (!panel) return;
        this._twoFactorSecret = result.secret;
        this._twoFactorQR = result.qrCode;
        panel.innerHTML = `
            <div class="text-center mb-4">
                <p class="font-bold text-emerald mb-2">Escanea este código con tu app de autenticación</p>
                <img src="${result.qrCode}" alt="QR 2FA" class="mx-auto" style="max-width: 200px; border-radius: 12px;">
                <p class="text-xs text-gray mt-2">Busca "TuRides" en tu app Authy / Google Authenticator</p>
                <div class="mt-3 p-3 bg-gray rounded">
                    <p class="text-xs text-gray mb-1">Si no puedes escanear, ingresa este código manualmente:</p>
                    <code class="text-sm font-bold text-purple select-all">${result.secret}</code>
                </div>
            </div>
            <div class="form-group">
                <label>Ingresa el código de 6 dígitos para verificar</label>
                <input type="text" id="twofa-verify-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" class="input" style="text-align: center; font-size: 1.3rem; letter-spacing: 0.4em;">
            </div>
            <button onclick="App.verifyAndEnable2FA()" class="btn btn-emerald w-full">Verificar y Activar 2FA</button>
            <button onclick="App.renderTwoFactorStatus()" class="btn btn-ghost w-full mt-2 text-sm">Cancelar</button>`;
    },

    async verifyAndEnable2FA() {
        const code = document.getElementById('twofa-verify-code')?.value;
        if (!code || code.length !== 6) { this.showToast('Ingresa un código de 6 dígitos.', 'error'); return; }
        const result = await API.post('/api/2fa/verify-and-enable', { userId: this.session.id, code });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.showToast('2FA activado correctamente!', 'success');
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.renderTwoFactorStatus();
    },

    async disable2FA() {
        const pw = document.getElementById('twofa-disable-pw')?.value;
        if (!pw) { this.showToast('Ingresa tu contraseña.', 'error'); return; }
        const result = await API.post('/api/2fa/disable', { userId: this.session.id, password: pw });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.showToast('2FA desactivado.', 'info');
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.renderTwoFactorStatus();
    },

    async changePassword() {
        const current = document.getElementById('sec-current-pw')?.value;
        const newPw = document.getElementById('sec-new-pw')?.value;
        const confirm = document.getElementById('sec-confirm-pw')?.value;
        if (!current || !newPw) { this.showToast('Completa todos los campos.', 'error'); return; }
        if (newPw !== confirm) { this.showToast('Las contraseñas no coinciden.', 'error'); return; }
        if (newPw.length < 3) { this.showToast('Mínimo 3 caracteres.', 'error'); return; }
        const result = await API.post('/api/change-password', { userId: this.session.id, currentPassword: current, newPassword: newPw });
        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.showToast('Contraseña actualizada!', 'success');
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        document.getElementById('sec-current-pw').value = '';
        document.getElementById('sec-new-pw').value = '';
        document.getElementById('sec-confirm-pw').value = '';
    },

    async adminSaveBankConfig() {
        const data = {
            bankName: document.getElementById('admin-cfg-bank')?.selectedOptions[0]?.text || '',
            accountNumber: document.getElementById('admin-cfg-account')?.value || '',
            holderName: document.getElementById('admin-cfg-holder')?.value || '',
            documentType: document.getElementById('admin-cfg-doctype')?.value || '',
            documentNumber: document.getElementById('admin-cfg-docnum')?.value || '',
            phone: document.getElementById('admin-cfg-phone')?.value || ''
        };
        await API.put('/api/config', data);
        this.showToast('Datos bancarios actualizados.', 'success');
        this.renderAdminDashboard();
    },

    async adminSaveCommission() {
        const pct = document.getElementById('admin-cfg-commission')?.value;
        if (isNaN(pct) || pct < 0 || pct > 50) { this.showToast('Comision invalida (0-50%).', 'error'); return; }
        await API.put('/api/config', { withdrawalCommission: String(pct) });
        this.showToast(`Comision actualizada a ${pct}%.`, 'success');
        this.renderAdminDashboard();
    },

    _selectedPassLevel: 'bronce',
    _passStatus: null,

    async openPassBuyModal() {
        this._passStatus = await API.get('/api/pass/status');
        const s = this._passStatus;
        const allowed = s.currentLevel === 'bronce' ? ['bronce'] : s.currentLevel === 'plata' ? ['bronce','plata'] : ['bronce','plata','oro'];
        this._selectedPassLevel = allowed[0];
        this._selectedPassPayment = this.session.balance > 0 ? 'rkm' : 'pago_movil';
        this._renderPassModal(s, allowed);
        document.getElementById('pass-buy-modal').classList.remove('hidden');
    },

    closePassBuyModal() {
        document.getElementById('pass-buy-modal').classList.add('hidden');
    },

    _renderPassModal(s, allowed) {
        const content = document.getElementById('pass-buy-content');
        if (!content) return;
        const tier = PASS_TIERS_CONFIG[this._selectedPassLevel];
        const credit = Math.min(s.referralCredits, tier.cost);
        const toPay = Math.max(0, tier.cost - credit);
        const session = this.session;
        const canPayRKM = session.balance >= toPay;

        let html = `<div class="mb-3"><p class="text-xs text-gray">Creditos por referidos: <strong class="text-emerald">$${s.referralCredits.toFixed(2)}</strong></p>
        <p class="text-xs text-gray">Nivel actual: <strong class="text-purple">${s.currentLevel.toUpperCase()}</strong></p></div>`;

        html += `<div class="payment-methods-grid" style="grid-template-columns:repeat(${allowed.length},1fr);margin-bottom:1rem;">`;
        allowed.forEach(level => {
            const t = PASS_TIERS_CONFIG[level];
            const sel = this._selectedPassLevel === level ? 'selected' : '';
            html += `<label class="payment-method-option ${sel}" onclick="App._selectPass('${level}')">
                <input type="radio" name="pass-level" value="${level}" ${sel ? 'checked' : ''}>
                <span class="pm-icon">${t.icon}</span>
                <span class="pm-name">PASS ${t.label}</span>
                <span class="pm-desc">$${t.cost} → hasta $${t.limit}</span>
            </label>`;
        });
        html += `</div>`;

        html += `<div class="p-3 bg-gray rounded mb-3">
            <div class="flex justify-between mb-1"><span class="text-xs text-gray">PASS ${tier.label}</span><span class="text-xs font-bold">$${tier.cost.toFixed(2)}</span></div>
            ${credit > 0 ? `<div class="flex justify-between mb-1"><span class="text-xs text-emerald">Credito referidos</span><span class="text-xs font-bold text-emerald">-$${credit.toFixed(2)}</span></div>` : ''}
            <div class="flex justify-between border-t border-gray pt-1"><span class="text-sm font-bold">A Pagar</span><span class="text-lg font-extrabold text-cyan">$${toPay.toFixed(2)}</span></div>
        </div>`;

        if (toPay > 0) {
            html += `<div class="mb-3">
                <label class="text-xs font-bold text-gray">Metodo de Pago</label>
                <div class="payment-methods-grid" style="grid-template-columns:1fr 1fr;">
                    <label class="payment-method-option ${canPayRKM ? 'selected' : ''}" onclick="App._selectedPassPayment='rkm'" data-method="rkm">
                        <input type="radio" name="pass-payment" value="rkm" ${canPayRKM ? 'checked' : ''}>
                        <span class="pm-icon">💰</span><span class="pm-name">Billetera</span>
                        <span class="pm-desc">Saldo: $${session.balance.toFixed(2)}</span>
                    </label>
                    <label class="payment-method-option" onclick="App._selectedPassPayment='pago_movil'" data-method="pago_movil">
                        <input type="radio" name="pass-payment" value="pago_movil">
                        <span class="pm-icon">📱</span><span class="pm-name">Pago Movil</span>
                        <span class="pm-desc">Transferencia bancaria</span>
                    </label>
                </div>
            </div>`;
        }

        const disabled = toPay > 0 && !canPayRKM && this._selectedPassPayment !== 'pago_movil' ? 'disabled' : '';
        html += `<button onclick="App.buyPass()" class="btn btn-purple w-full" ${disabled}>${toPay > 0 ? `Pagar $${toPay.toFixed(2)} y Activar PASS` : 'Activar PASS Gratis (Creditos)'}</button>`;
        content.innerHTML = html;
    },

    _selectPass(level) {
        this._selectedPassLevel = level;
        if (this._passStatus) {
            const allowed = this._passStatus.currentLevel === 'bronce' ? ['bronce'] : this._passStatus.currentLevel === 'plata' ? ['bronce','plata'] : ['bronce','plata','oro'];
            this._renderPassModal(this._passStatus, allowed);
        }
    },

    _selectedPassPayment: 'rkm',

    async buyPass() {
        const paymentMethod = this._selectedPassPayment || 'rkm';
        const passStatus = await API.get('/api/pass/status');
        const tier = PASS_TIERS_CONFIG[this._selectedPassLevel];
        const credit = Math.min(passStatus.referralCredits, tier.cost);
        const toPay = Math.max(0, tier.cost - credit);

        if (toPay > 0 && paymentMethod === 'rkm' && this.session.balance < toPay) {
            this.showToast('Saldo insuficiente en billetera.', 'error');
            return;
        }

        const result = await API.post('/api/pass/buy', {
            passLevel: this._selectedPassLevel,
            paymentMethod,
            creditApplied: credit
        });

        if (result.error) { this.showToast(result.error, 'error'); return; }
        this.showToast(result.message, 'success');
        this.closePassBuyModal();
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.renderConductorWallet();
        this.renderNavbar();
    },

    logout() {
        this.stopPendingTimer();
        localStorage.removeItem('turides_session');
        this.session = null;
        this.route();
        this.showToast('Sesion cerrada.', 'info');
    },

    hardReset() {
        localStorage.clear();
        sessionStorage.clear();
        window.location.reload();
    },

    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);
        setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(-20px)'; setTimeout(() => toast.remove(), 400); }, 5000);
    }
};

window.addEventListener('DOMContentLoaded', () => { App.init(); });

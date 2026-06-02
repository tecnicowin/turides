const socket = io();

const KILOMETER_RATE_CONFIG = { carro: { base: 1.80, perKm: 0.50, minDistance: 2.5 }, moto: { base: 0.80, perKm: 0.20, minDistance: 2.5 } };

const API = {
    async get(url) { const r = await fetch(url); return r.json(); },
    async post(url, data) { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return r.json(); },
    async put(url, data) { const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); return r.json(); }
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
        if (window.location.search.includes('reset=true')) {
            if (!confirm('ADVERTENCIA: Esto borrara TODOS los datos del sistema.\n\nUsuarios, viajes, transacciones y configuracion seran eliminados.\n\n¿Realmente deseas continuar?')) {
                window.history.replaceState({}, '', window.location.pathname);
                window.location.href = '/';
                return;
            }
            try { await API.post('/api/setup/reset', { confirm: 'DELETE_ALL_DATA' }); } catch(e) {}
            localStorage.clear();
            sessionStorage.clear();
            window.history.replaceState({}, '', window.location.pathname);
            this._setupStatus = { hasAdmin: false, adminSetupComplete: false, totalUsers: 0 };
            await this.loadFareInfo();
            this.setupEventListeners();
            this.setupSocketListeners();
            this.showView('setup');
            this.showToast('Sistema reiniciado. Crea tu cuenta de administrador.', 'success');
            return;
        }
        this._setupStatus = await API.get('/api/setup/status');
        const savedSession = localStorage.getItem('turides_session');
        if (savedSession) {
            try {
                const parsed = JSON.parse(savedSession);
                const fresh = await API.get(`/api/users/${parsed.id}`);
                if (fresh && !fresh.error) {
                    this.session = fresh;
                } else {
                    localStorage.removeItem('turides_session');
                }
            } catch(e) {
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
                socket.emit('join', this.session.role + '_' + this.session.id);
            }
        });

        socket.on('trip:new_request', (trip) => {
            if (this.session && this.session.role === 'conductor' && trip.conductorId === this.session.id) {
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
            if (this.session.role === 'conductor' && trip.conductorId === this.session.id) {
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

        socket.on('connect', () => {
            if (this.session) {
                socket.emit('join', this.session.role + '_' + this.session.id);
            }
        });

        socket.on('reconnect', () => {
            if (this.session) {
                socket.emit('join', this.session.role + '_' + this.session.id);
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
            socket.emit('join', this.session.role + '_' + this.session.id);
            if (this.session.role === 'conductor') this.startConductorPolling();
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
            case 'admin': await this.renderAdminDashboard(); break;
        }
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

        document.getElementById('reg-role')?.addEventListener('change', (e) => {
            document.getElementById('reg-conductor-block').style.display = e.target.value === 'conductor' ? 'block' : 'none';
        });

        document.getElementById('register-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const data = {
                name: document.getElementById('reg-name').value,
                phone: document.getElementById('reg-phone').value,
                email: document.getElementById('reg-email').value,
                password: document.getElementById('reg-password').value,
                role: document.getElementById('reg-role').value
            };
            if (data.role === 'conductor') {
                data.vehicleData = {
                    type: document.querySelector('input[name="reg-vehicle-type"]:checked')?.value || 'carro',
                    brand: document.getElementById('reg-brand').value || 'Toyota',
                    model: document.getElementById('reg-model').value || 'Corolla',
                    passengers: document.getElementById('reg-passengers').value || 4,
                    suitcases: document.getElementById('reg-suitcases').value || 2,
                    tariffMode: 'kilometros'
                };
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
            else if (activeTrip.status === 'completado') { statusMsg = 'Viaje completado. Esperando verificacion de pago...'; statusBadge = 'text-cyan animate-pulse'; }
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
                html += `<div class="p-3 bg-dark rounded border-l-cyan mb-4"><p class="text-xs text-cyan font-bold font-heading animate-pulse">El conductor esta verificando tu pago...</p></div>`;
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
            let thtml = '<table class="table"><thead><tr><th>Conductor</th><th>Ruta</th><th>Precio</th><th>Pago</th><th>Calificacion</th><th>Estado</th></tr></thead><tbody>';
            closedTrips.forEach(t => {
                const sc = t.status === 'calificado' ? 'text-purple' : t.status === 'completado' ? 'text-emerald' : 'text-red';
                const pl = t.paymentMethod === 'rkm' ? 'RKM' : 'P.Movil';
                const rHtml = t.conductorRating ? this.renderStarsSmall(t.conductorRating, 1) : '<span class="text-xs text-gray">Pendiente</span>';
                thtml += `<tr><td><strong>${t.conductorName}</strong><br><span class="text-xs text-gray">${t.conductorVehicle}</span></td><td><span class="text-xs font-bold">${t.originAddress}</span> ➔ <span class="text-xs">${t.destinationAddress}</span></td><td class="font-bold text-emerald">$${t.price.toFixed(2)} <span class="text-xs text-gray">Bs ${this.toBs(t.price)}</span></td><td><span class="badge text-cyan">${pl}</span></td><td>${rHtml}</td><td class="${sc} font-bold">${t.status.toUpperCase()}</td></tr>`;
            });
            thtml += '</tbody></table>';
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
        if (!simulatedKm || simulatedKm <= 0) {
            simulatedKm = 5.0;
            if (distBadge) distBadge.innerHTML = `Distancia estimada: <strong class="text-yellow">${simulatedKm.toFixed(1)} km</strong> <span class="text-xs text-gray">(no se pudo geolocalizar, estimado)</span>`;
        } else {
            if (distBadge) distBadge.innerHTML = `Distancia calculada: <strong class="text-cyan">${simulatedKm.toFixed(1)} km</strong>`;
        }
        this.calculatedDistance = simulatedKm;
        if (distBadge) { distBadge.innerHTML = `Kilometros calculados: <strong class="text-cyan">${simulatedKm.toFixed(1)} km</strong>`; distBadge.style.display = 'block'; }
        this.foundConductors = await API.get(`/api/conductors/available?distance=${simulatedKm}&vehicleType=${vehicleType}`);
        if (this.foundConductors.length === 0) { listDiv.innerHTML = `<div class="p-4 bg-gray rounded text-center"><p class="text-red font-bold">Sin conductores de ${vehicleType === 'moto' ? 'moto' : 'carro'} disponibles</p></div>`; return; }
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
            const vIcon = c.vehicle?.type === 'moto' ? '🏍️' : '🚗';
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
        await API.post('/api/trips', { clientId: this.session.id, clientName: this.session.name, clientPhone: this.session.phone, originAddress: origin, destinationAddress: dest, distance: this.calculatedDistance, conductorId, price, paymentMethod });
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
    openRKMRechargeModal() { document.getElementById('rkm-recharge-modal').classList.remove('hidden'); },
    closeRKMRechargeModal() { document.getElementById('rkm-recharge-modal').classList.add('hidden'); },

    async processRKMRecharge() {
        const amount = parseFloat(document.getElementById('recharge-amount').value);
        if (isNaN(amount) || amount <= 0) { this.showToast('Ingresa un monto valido.', 'error'); return; }
        await API.post('/api/rkm/recharge', { userId: this.session.id, amount });
        this.session = await API.get(`/api/users/${this.session.id}`);
        localStorage.setItem('turides_session', JSON.stringify(this.session));
        this.closeRKMRechargeModal();
        this.showToast(`Billetera RKM recargada con $${amount.toFixed(2)}.`, 'success');
        this.updateViewContent();
        this.renderNavbar();
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
        details.innerHTML = `<div class="detail-row"><span class="detail-label">Conductor</span><span class="detail-value">${trip.conductorName}</span></div><div class="detail-row"><span class="detail-label">Celular</span><span class="detail-value">${trip.conductorPhone}</span></div><div class="detail-row"><span class="detail-label">Vehiculo</span><span class="detail-value">${trip.conductorVehicle}</span></div><div class="detail-row"><span class="detail-label">Ruta</span><span class="detail-value" style="font-size:0.75rem; text-align:right;">${trip.originAddress} → ${trip.destinationAddress}</span></div><div class="detail-row"><span class="detail-label">Distancia</span><span class="detail-value" style="color:#22d3ee;">${trip.distance.toFixed(1)} km</span></div><div class="detail-row"><span class="detail-label">Tarifa</span><span class="detail-value" style="color:#34d399; font-size:1.1rem;">$${trip.price.toFixed(2)} <span style="font-size:0.75rem; color:#9ca3af;">Bs ${this.toBs(trip.price)}</span></span></div>`;
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
            const paymentLabel = isRKM ? 'Billetera TuRides (Transferencia Interna)' : 'Pago Movil Directo';
            const paymentColor = isRKM ? 'text-emerald' : 'text-cyan';
            const paymentIcon = isRKM ? '💰' : '📱';

            let html = `<div class="glass-card"><div class="flex justify-between items-center mb-4 border-b border-gray pb-2"><h3 class="text-xl font-bold">Solicitud Entrante</h3><span class="badge ${activeTrip.status === 'aceptado' ? 'text-emerald' : 'text-cyan animate-pulse'}">${activeTrip.status.toUpperCase()}</span></div>
            <div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">Datos del Solicitante:</h4><p class="text-sm"><strong>Cliente:</strong> ${activeTrip.clientName}</p><p class="text-sm"><strong>Celular:</strong> ${activeTrip.clientPhone}</p></div>
            <div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1 flex items-center gap-1">${paymentIcon} Metodo de Pago:</h4><p class="text-sm font-bold ${paymentColor}">${paymentLabel}</p>${isRKM ? '<p class="text-xs text-gray mt-1">El pago se realiza automaticamente por transferencia electronica al completar el viaje.</p>' : '<p class="text-xs text-gray mt-1">El cliente te hara un Pago Movil directo al llegar al destino. Verifica el pago en persona.</p>'}</div>
            <div class="mb-4"><h4 class="font-bold text-sm mb-1">Detalles de Ruta:</h4><p class="text-sm"><strong>Salida:</strong> ${activeTrip.originAddress}</p><p class="text-sm"><strong>Destino:</strong> ${activeTrip.destinationAddress}</p><p class="text-sm"><strong>Distancia:</strong> ${activeTrip.distance.toFixed(1)} km</p></div>
            <div class="pricing-card flex justify-between items-center mb-4"><span class="font-bold text-sm">Pago</span><div class="text-right"><span class="text-2xl font-extrabold text-emerald">$${activeTrip.price.toFixed(2)}</span><br><span class="text-xs text-gray">Bs ${this.toBs(activeTrip.price)}</span></div></div>`;

            if (activeTrip.status === 'pendiente') {
                html += `<div class="flex gap-2"><button onclick="App.acceptTripByConductor('${activeTrip.id}')" class="btn btn-emerald flex-1">Aceptar Servicio</button><button onclick="App.rejectTripByConductor('${activeTrip.id}')" class="btn btn-red flex-1">Rechazar</button></div>`;
            } else if (activeTrip.status === 'aceptado') {
                if (!isRKM) {
                    const driverBank = this.session.bankInfo || {};
                    const hasBank = driverBank.bank && driverBank.account;
                    html += `<div class="p-3 bg-dark rounded border-l-purple mb-3"><p class="text-xs text-emerald font-bold mb-2">Has aceptado este servicio. Contacta al ${activeTrip.clientPhone}.</p>`;
                    if (hasBank) {
                        html += `<div class="p-2 bg-gray rounded mt-2"><p class="text-xs text-cyan font-bold">Comparte estos datos al cliente para el Pago Movil:</p><p class="text-sm"><strong>Banco:</strong> ${driverBank.bank}</p><p class="text-sm"><strong>Cuenta:</strong> ${driverBank.account}</p><p class="text-sm"><strong>Telefono:</strong> ${driverBank.phone || this.session.phone}</p><p class="text-sm"><strong>Titular:</strong> ${driverBank.name || this.session.name}</p></div>`;
                    } else {
                        html += `<p class="text-xs text-red mt-2">⚠️ No tienes cuenta bancaria configurada. Configurala en tu billetera para recibir pagos.</p>`;
                    }
                    html += `</div>`;
                } else {
                    html += `<div class="p-3 bg-dark rounded border-l-purple text-center"><p class="text-xs text-emerald font-bold mb-2">Has aceptado este servicio. Contacta al ${activeTrip.clientPhone}.</p><p class="text-xs text-gray">El pago se transferira automaticamente al completar.</p></div>`;
                }
                html += `<button onclick="App.completeTripByConductor('${activeTrip.id}')" class="btn btn-purple w-full mt-3">Completar Viaje</button>`;
            } else if (activeTrip.status === 'completado') {
                if (isRKM) {
                    html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4 text-center"><p class="text-xs text-emerald font-bold mb-2">✅ Pago procesado automaticamente via Billetera TuRides.</p><p class="text-sm text-gray">Monto: <strong class="text-emerald">$${activeTrip.price.toFixed(2)}</strong> <span class="text-xs">(Bs ${this.toBs(activeTrip.price)})</span></p><p class="text-xs text-gray mt-1">El saldo fue transferido del cliente a tu billetera.</p></div><button onclick="App.confirmPaymentByConductor('${activeTrip.id}')" class="btn btn-emerald w-full">Pago Verificado ✓</button>`;
                } else {
                    html += `<div class="p-3 bg-dark rounded border-l-cyan mb-4 text-center"><p class="text-xs text-cyan font-bold mb-2">⏳ Esperando que el cliente realice el Pago Movil.</p><p class="text-sm text-gray mb-1">Monto: <strong class="text-emerald">$${activeTrip.price.toFixed(2)}</strong> <span class="text-xs">(Bs ${this.toBs(activeTrip.price)})</span></p><p class="text-xs text-gray">Verifica el pago en persona con el cliente antes de continuar.</p></div><button onclick="App.confirmPaymentByConductor('${activeTrip.id}')" class="btn btn-emerald w-full">Pago Verificado ✓</button>`;
                }
            } else if (activeTrip.status === 'pago_verificado') {
                html += `<div class="p-3 bg-dark rounded border-l-emerald mb-4 text-center"><p class="text-xs text-emerald font-bold mb-2">Pago verificado. Califica al cliente.</p></div><button onclick="App.openRatingModal('${activeTrip.id}', '${activeTrip.clientId}', '${activeTrip.clientName}', 'conductor')" class="btn btn-purple w-full">Calificar al Cliente ⭐</button>`;
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
        const myCompleted = trips.filter(t => t.conductorId === this.session.id && t.status === 'pago_verificado');
        const totalEarned = myCompleted.reduce((acc, t) => acc + t.price, 0);

        const banks = [
            { code: '0102', name: 'Banco de Venezuela' },
            { code: '0104', name: 'Banco Provincial' },
            { code: '0105', name: 'Banco Mercantil' },
            { code: '0108', name: 'Banco BBVA' },
            { code: '0114', name: 'Banco Bancaribe' },
            { code: '0116', name: 'Banco Plaza' },
            { code: '0128', name: 'Banco Occidental' },
            { code: '0134', name: 'Banco Venezolano de Credito' },
            { code: '0151', name: 'Banco BFC' },
            { code: '0156', name: '100% Banco' },
            { code: '0157', name: 'Banco Del Tesoro' },
            { code: '0163', name: 'Banco Guerra' },
            { code: '0168', name: 'Bancrecer' },
            { code: '0169', name: 'Mi Banco' },
            { code: '0171', name: 'Banco del Pueblo Soberano' },
            { code: '0172', name: 'Bancamiga' },
            { code: '0173', name: 'Banco Internacional' },
            { code: '0174', name: 'Banplus' },
            { code: '0175', name: 'Bicentenario' },
            { code: '0177', name: 'Banco Facilito' },
            { code: '0185', name: 'Fondo Comun' }
        ];

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

        html += `
            <div class="glass-card mb-4">
                <h3 class="text-lg font-bold mb-3">🏦 ${hasBank ? 'Actualizar Cuenta Bancaria' : 'Configurar Cuenta Bancaria'}</h3>
                <p class="text-xs text-gray mb-3">${hasBank ? 'Modifica los datos de tu cuenta para recibir retiros.' : 'Ingresa los datos de tu cuenta para poder solicitar retiros.'}</p>
                <div class="form-group">
                    <label>Banco</label>
                    <select id="driver-bank-select" class="input">
                        <option value="">Seleccionar banco</option>
                        ${banks.map(b => `<option value="${b.code}" ${bankInfo.bank === b.code ? 'selected' : ''}>${b.code} - ${b.name}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Número de Cuenta</label>
                    <input type="text" id="driver-bank-account" class="input" value="${bankInfo.account || ''}" placeholder="Ej. 0102-1234-5678-9012">
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
            html += `<div class="glass-card mb-4"><h3 class="text-lg font-bold mb-3 text-emerald">✅ Retiros Aprobados/Realizados (${approvedW.length})</h3>`;
            approvedW.slice(0, 5).forEach(w => {
                const date = w.reviewedAt ? new Date(w.reviewedAt).toLocaleDateString() : '-';
                const net = w.netAmount || (w.amount - (w.commission || 0));
                if (w.status === 'realizado') {
                    html += `<div class="p-3 bg-gray rounded mb-2"><div class="flex justify-between items-center"><span class="font-bold text-emerald">$${net.toFixed(2)} transferidos</span><span class="badge text-emerald">REALIZADO</span></div><p class="text-xs text-gray mt-1">Ref: <strong class="text-cyan">${w.reference || 'Sin referencia'}</strong> | ${date}</p></div>`;
                } else {
                    html += `<div class="p-2 bg-gray rounded mb-1 flex justify-between text-xs"><span>$${w.amount.toFixed(2)} - ${date}</span><span class="badge text-emerald">Aprobado</span></div>`;
                }
            });
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
        const phone = document.getElementById('driver-bank-phone')?.value?.trim();
        const name = document.getElementById('driver-bank-name')?.value?.trim();
        if (!bank) { this.showToast('Selecciona un banco.', 'error'); return; }
        if (!account || account.length < 10) { this.showToast('Numero de cuenta invalido.', 'error'); return; }
        if (!name) { this.showToast('Nombre del titular requerido.', 'error'); return; }
        const bankInfo = { bank, account, phone, name };
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
        const pendingRecharges = recharges.filter(r => r.status === 'pendiente').length;
        const pendingWithdrawals = withdrawals.filter(w => w.status === 'pendiente').length;

        document.getElementById('admin-stat-trips').textContent = trips.length;
        document.getElementById('admin-stat-completed').textContent = completed.length;
        document.getElementById('admin-stat-volume').innerHTML = `$${volume.toFixed(2)}<br><span class="text-xs text-gray">Bs ${this.toBs(volume)}</span>`;
        document.getElementById('admin-stat-platform').innerHTML = `$${(volume * 0.15).toFixed(2)}<br><span class="text-xs text-gray">Bs ${this.toBs(volume * 0.15)}</span>`;

        const pendingBadge = document.getElementById('admin-stat-pending');
        if (pendingBadge) pendingBadge.textContent = pendingRecharges + pendingWithdrawals;

        const bcvRateEl = document.getElementById('admin-bcv-rate');
        if (bcvRateEl) bcvRateEl.value = config.bcvRate || '36.50';

        const usersTable = document.getElementById('admin-users-list');
        let html = '<table class="table"><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Vehiculo</th><th>Billetera</th><th>2FA</th><th>Rating</th></tr></thead><tbody>';
        users.forEach(u => {
            const vt = u.role === 'conductor' ? `${u.vehicle?.type === 'moto' ? '🏍️' : '🚗'} ${u.vehicle?.brand} ${u.vehicle?.model}` : '-';
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

        this.renderAdminBankConfig(config);

        try { this.renderAdminSupport(recharges, withdrawals); } catch(e) { console.error('Support panel error:', e); }
    },

    renderAdminSupport(recharges, withdrawals) {
        const container = document.getElementById('admin-support-panel');
        if (!container) return;

        let html = '';

        html += `<div class="mb-6"><h3 class="text-lg font-bold mb-3 text-cyan">📥 Recargas de Clientes (${recharges.length})</h3>`;
        if (recharges.length === 0) {
            html += `<p class="text-center text-gray p-4">No hay solicitudes de recarga.</p>`;
        } else {
            html += '<table class="table"><thead><tr><th>ID</th><th>Cliente</th><th>Monto</th><th>Banco</th><th>Ref</th><th>Estado</th><th>Accion</th></tr></thead><tbody>';
            recharges.forEach(r => {
                const statusColor = r.status === 'aprobada' ? 'text-emerald' : r.status === 'rechazada' ? 'text-red' : 'text-cyan';
                html += `<tr>
                    <td class="text-xs font-mono">${r.id.slice(-8)}</td>
                    <td><strong>${r.userName}</strong></td>
                    <td class="font-bold text-emerald">$${r.amount.toFixed(2)} <span class="text-xs">Bs ${this.toBs(r.amount)}</span></td>
                    <td class="text-xs">${r.bankCode || '-'}</td>
                    <td class="text-xs font-mono">${r.reference || '-'}</td>
                    <td><span class="badge ${statusColor}">${r.status.toUpperCase()}</span></td>
                    <td>${r.status === 'pendiente' ? `<div class="flex gap-1"><button onclick="App.adminReviewRecharge('${r.id}', 'aprobada')" class="btn btn-emerald btn-sm">✓</button><button onclick="App.adminReviewRecharge('${r.id}', 'rechazada')" class="btn btn-red btn-sm">✗</button></div>` : '<span class="text-xs text-gray">' + (r.adminNote || 'Revisado') + '</span>'}</td>
                </tr>`;
            });
            html += '</tbody></table>';
        }
        html += `</div>`;

        html += `<div><h3 class="text-lg font-bold mb-3 text-purple">📤 Retiros de Conductores (${withdrawals.length})</h3>`;
        if (withdrawals.length === 0) {
            html += `<p class="text-center text-gray p-4">No hay solicitudes de retiro.</p>`;
        } else {
            withdrawals.forEach(w => {
                const statusColor = w.status === 'aprobada' ? 'text-emerald' : w.status === 'rechazada' ? 'text-red' : w.status === 'realizado' ? 'text-purple' : 'text-cyan';
                const bInfo = JSON.parse(w.bankInfo || '{}');
                const bankNames = { '0102': 'Banco de Venezuela', '0104': 'Banco Provincial', '0105': 'Banco Mercantil', '0108': 'Banco BBVA', '0114': 'Banco Bancaribe', '0116': 'Banco Plaza', '0128': 'Banco Occidental', '0134': 'Banco Venezolano', '0151': 'Banco BFC', '0156': '100% Banco', '0157': 'Banco Del Tesoro', '0163': 'Banco Guerra', '0168': 'Bancrecer', '0169': 'Mi Banco', '0171': 'Banco del Pueblo', '0172': 'Bancamiga', '0173': 'Banco Internacional', '0174': 'Banplus', '0175': 'Bicentenario', '0177': 'Banco Facilito', '0185': 'Fondo Comun' };
                const bankName = bankNames[bInfo.bank] || bInfo.bank || '-';
                const commission = w.commission || 0;
                const netAmount = w.netAmount || (w.amount - commission);

                html += `<div class="glass-card mb-3 p-4 border-l-purple">
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
                    ${w.status === 'realizado' ? `<div class="mt-2 p-2 bg-emerald rounded text-xs"><p class="font-bold text-emerald">✅ Transferencia realizada</p><p>Ref: <strong>${w.reference || '-'}</strong></p></div>` : ''}
                    ${w.status === 'rechazada' ? `<div class="mt-2 text-xs text-gray">${w.adminNote ? `<strong>Motivo:</strong> ${w.adminNote}` : 'Rechazado'}</div>` : ''}
                </div>`;
            });
        }
        html += `</div>`;

        container.innerHTML = html;
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
                        <option value="0102">Banco de Venezuela</option>
                        <option value="0104">Banco Provincial</option>
                        <option value="0105">Banco Mercantil</option>
                        <option value="0108">Banco BBVA</option>
                        <option value="0114">Banco Bancaribe</option>
                        <option value="0116">Banco Plaza</option>
                        <option value="0128">Banco Occidental</option>
                        <option value="0134">Banco Venezolano de Credito</option>
                        <option value="0151">Banco BFC</option>
                        <option value="0156">100% Banco</option>
                        <option value="0157">Banco Del Tesoro</option>
                        <option value="0163">Banco Guerra</option>
                        <option value="0168">Bancrecer</option>
                        <option value="0169">Mi Banco</option>
                        <option value="0171">Banco del Pueblo Soberano</option>
                        <option value="0172">Bancamiga</option>
                        <option value="0173">Banco Internacional</option>
                        <option value="0174">Banplus</option>
                        <option value="0175">Bicentenario</option>
                        <option value="0177">Banco Facilito</option>
                        <option value="0185">Fondo Comun</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Referencia (6 digitos)</label>
                    <input type="text" id="settings-recharge-ref" placeholder="Ej. 123456" maxlength="6" class="input">
                </div>
                <button onclick="App.submitRecharge()" class="btn btn-emerald w-full">Enviar Solicitud de Recarga</button>
            </div>
            <div class="glass-card">
                <h3 class="text-lg font-bold mb-3">📋 Mis Recargas</h3>`;
        if (myRecharges.length === 0) {
            html += `<p class="text-center text-gray p-4">No tienes recargas registradas.</p>`;
        } else {
            html += '<table class="table"><thead><tr><th>Monto</th><th>Ref</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>';
            myRecharges.forEach(r => {
                const sc = r.status === 'aprobada' ? 'text-emerald' : r.status === 'rechazada' ? 'text-red' : 'text-cyan';
                const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '-';
                html += `<tr><td class="font-bold text-emerald">$${r.amount.toFixed(2)} <span class="text-xs">Bs ${this.toBs(r.amount)}</span></td><td class="text-xs font-mono">${r.reference || '-'}</td><td><span class="badge ${sc}">${r.status.toUpperCase()}</span></td><td class="text-xs">${date}</td></tr>`;
            });
            html += '</tbody></table>';
        }
        html += `</div>`;

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
        const banks = [
            { code: '0102', name: 'Banco de Venezuela' },
            { code: '0104', name: 'Banco Provincial' },
            { code: '0105', name: 'Banco Mercantil' },
            { code: '0108', name: 'Banco BBVA' },
            { code: '0114', name: 'Banco Bancaribe' },
            { code: '0116', name: 'Banco Plaza' },
            { code: '0128', name: 'Banco Occidental' },
            { code: '0134', name: 'Banco Venezolano de Credito' },
            { code: '0151', name: 'Banco BFC' },
            { code: '0156', name: '100% Banco' },
            { code: '0157', name: 'Banco Del Tesoro' },
            { code: '0163', name: 'Banco Guerra' },
            { code: '0168', name: 'Bancrecer' },
            { code: '0169', name: 'Mi Banco' },
            { code: '0171', name: 'Banco del Pueblo Soberano' },
            { code: '0172', name: 'Bancamiga' },
            { code: '0173', name: 'Banco Internacional' },
            { code: '0174', name: 'Banplus' },
            { code: '0175', name: 'Bicentenario' },
            { code: '0177', name: 'Banco Facilito' },
            { code: '0185', name: 'Fondo Comun' }
        ];
        const bankOptions = banks.map(b => `<option value="${b.code}" ${config.bankName === b.name ? 'selected' : ''}>${b.code} - ${b.name}</option>`).join('');

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

    async adminReset() {
        if (!confirm('ELIMINAR TODOS LOS DATOS?\n\nEsto borrará todos los usuarios, viajes, transacciones y configuración.\nDespués podrás crear un nuevo administrador.\n\n¿Continuar?')) return;
        try {
            const result = await API.post('/api/setup/reset', { confirm: 'DELETE_ALL_DATA' });
            if (result.success) {
                localStorage.removeItem('turides_session');
                this.session = null;
                this._setupStatus = { hasAdmin: false, adminSetupComplete: false, totalUsers: 0 };
                this.showToast('Sistema reiniciado. Crea tu cuenta de administrador.', 'success');
                this.showView('setup');
            }
        } catch(err) { this.showToast('Error al resetear.', 'error'); }
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

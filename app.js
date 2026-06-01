const socket = io();

const KILOMETER_RATE_CONFIG = { carro: { base: 4.00, perKm: 0.95, minDistance: 2.5 }, moto: { base: 2.00, perKm: 0.45, minDistance: 2.5 } };

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

    async init() {
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

        socket.on('user:updated', (user) => {
            if (!this.session) return;
            if (user.id === this.session.id) {
                this.session = user;
                localStorage.setItem('turides_session', JSON.stringify(user));
                this.renderNavbar();
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
            this.showView('login');
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
            const labels = { normal: 'Tarifa Normal', diurno: 'Tarifa Diurna', pico: 'Hora Pico +30%', noche: 'Noche +20%' };
            const colors = { normal: 'text-emerald', diurno: 'text-emerald', pico: 'text-red', noche: 'text-cyan' };
            fareLabel.textContent = labels[this._fareInfo.period] || 'Tarifa Normal';
            fareLabel.className = `badge text-xs ${colors[this._fareInfo.period] || 'text-emerald'}`;
        }
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
                const user = await API.post('/api/login', { email, password: pass });
                if (user.error) { this.showToast(user.error, 'error'); return; }
                this.session = user;
                localStorage.setItem('turides_session', JSON.stringify(user));
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
            const farePeriodLabels = { normal: '', diurno: '', pico: ' (Hora Pico +30%)', noche: ' (Noche +20%) };
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
                html += `<div class="p-3 bg-dark rounded border-l-purple mb-4"><p class="text-xs text-purple font-bold font-heading">El conductor se comunicara contigo para coordinar.</p></div>
                <button onclick="App.completeTrip('${activeTrip.id}')" class="btn btn-emerald w-full">Finalizar Viaje y Pagar</button>`;
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
            const labels = { normal: 'Tarifa Normal', diurno: 'Tarifa Diurna', pico: 'Hora Pico (+30%)', noche: 'Noche (+20%)' };
            fareInfoEl.textContent = labels[this._fareInfo.period] || 'Tarifa Normal';
        }
    },

    async processAutomatedSearch() {
        const origin = document.getElementById('client-origin-address').value;
        const dest = document.getElementById('client-destination-address').value;
        const paymentMethod = document.querySelector('input[name="payment-method"]:checked')?.value || 'rkm';
        const vehicleType = document.querySelector('input[name="vehicle-type"]:checked')?.value || 'carro';
        const distBadge = document.getElementById('gps-calculated-distance-badge');
        const listDiv = document.getElementById('available-conductors-list');
        if (!origin || !dest) { this.showToast('Introduce direccion de salida y llegada.', 'error'); return; }
        const textLength = origin.length + dest.length;
        const simulatedKm = parseFloat(((textLength % 28) + 10.5).toFixed(1));
        this.calculatedDistance = simulatedKm;
        if (distBadge) { distBadge.innerHTML = `Kilometros calculados: <strong class="text-cyan">${simulatedKm.toFixed(1)} km</strong>`; distBadge.style.display = 'block'; }
        this.foundConductors = await API.get(`/api/conductors/available?distance=${simulatedKm}&vehicleType=${vehicleType}`);
        if (this.foundConductors.length === 0) { listDiv.innerHTML = `<div class="p-4 bg-gray rounded text-center"><p class="text-red font-bold">Sin conductores de ${vehicleType === 'moto' ? 'moto' : 'carro'} disponibles</p></div>`; return; }
        let html = '';
        const fareLabels = { normal: '', diurno: '', pico: ' (HP +30%)', noche: ' (Noche +20%) };
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
        this._pendingTripId = tripId;
        const trips = await API.get('/api/trips');
        const trip = trips.find(t => t.id === tripId);
        if (!trip) return;
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
        this.selectPaymentMethod(this._selectedPaymentMethod || 'rkm');
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

    cancelTrip(tripId) {
        this.stopPendingTimer();
        API.put(`/api/trips/${tripId}/status`, { status: 'rechazado' });
        this.showToast('Solicitud cancelada.', 'info');
        this.updateViewContent();
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
            let html = `<div class="glass-card"><div class="flex justify-between items-center mb-4 border-b border-gray pb-2"><h3 class="text-xl font-bold">Solicitud Entrante</h3><span class="badge ${activeTrip.status === 'aceptado' ? 'text-emerald' : 'text-cyan animate-pulse'}">${activeTrip.status.toUpperCase()}</span></div>
            <div class="p-3 bg-gray rounded mb-4"><h4 class="font-bold text-sm mb-1">Datos del Solicitante:</h4><p class="text-sm"><strong>Cliente:</strong> ${activeTrip.clientName}</p><p class="text-sm"><strong>Celular:</strong> ${activeTrip.clientPhone}</p></div>
            <div class="mb-4"><h4 class="font-bold text-sm mb-1">Detalles de Ruta:</h4><p class="text-sm"><strong>Salida:</strong> ${activeTrip.originAddress}</p><p class="text-sm"><strong>Destino:</strong> ${activeTrip.destinationAddress}</p><p class="text-sm"><strong>Distancia:</strong> ${activeTrip.distance.toFixed(1)} km</p></div>
            <div class="pricing-card flex justify-between items-center mb-4"><span class="font-bold text-sm">Pago</span><div class="text-right"><span class="text-2xl font-extrabold text-emerald">$${activeTrip.price.toFixed(2)}</span><br><span class="text-xs text-gray">Bs ${this.toBs(activeTrip.price)}</span></div></div>`;

            if (activeTrip.status === 'pendiente') {
                html += `<div class="flex gap-2"><button onclick="App.acceptTripByConductor('${activeTrip.id}')" class="btn btn-emerald flex-1">Aceptar Servicio</button><button onclick="App.rejectTripByConductor('${activeTrip.id}')" class="btn btn-red flex-1">Rechazar</button></div>`;
            } else if (activeTrip.status === 'aceptado') {
                html += `<div class="p-3 bg-dark rounded border-l-purple text-center"><p class="text-xs text-emerald font-bold mb-2">Has aceptado este servicio. Contacta al ${activeTrip.clientPhone}.</p><button onclick="App.completeTripByConductor('${activeTrip.id}')" class="btn btn-purple w-full">Completar Viaje</button></div>`;
            } else if (activeTrip.status === 'completado') {
                const pml = activeTrip.paymentMethod === 'rkm' ? 'Billetera RKM' : 'Pago Movil';
                html += `<div class="p-3 bg-dark rounded border-l-cyan mb-4 text-center"><p class="text-xs text-cyan font-bold mb-2">Viaje completado. Verifica el pago.</p><p class="text-sm text-gray mb-3">Metodo: <strong>${pml}</strong> | Monto: <strong class="text-emerald">$${activeTrip.price.toFixed(2)}</strong> <span class="text-xs">(Bs ${this.toBs(activeTrip.price)})</span></p></div><button onclick="App.confirmPaymentByConductor('${activeTrip.id}')" class="btn btn-emerald w-full">Pago Verificado ✓</button>`;
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
                    <p class="text-xs text-gray">Cuenta bancaria registrada:</p>
                    <p class="text-sm font-bold">${hasBank ? `${bankInfo.bank} - ${bankInfo.account}` : 'No configurada'}</p>
                </div>`;

        if (hasBank) {
            html += `
                <div class="form-group">
                    <label>Monto a retirar ($)</label>
                    <input type="number" id="withdraw-amount" min="1" step="0.01" max="${this.session.balance}" placeholder="Ej. 20.00" class="input">
                </div>
                <button onclick="App.requestWithdrawal()" class="btn btn-emerald w-full">Solicitar Retiro a Cuenta Bancaria</button>`;
        } else {
            html += `<p class="text-xs text-red text-center">Configura tu cuenta bancaria en Configuracion para poder retirar.</p>`;
        }

        if (pendingW.length > 0) {
            html += `<div class="mt-3"><p class="text-xs text-cyan font-bold mb-1">Retiros Pendientes:</p>`;
            pendingW.forEach(w => {
                html += `<div class="p-2 bg-gray rounded mb-1 flex justify-between text-xs"><span>$${w.amount.toFixed(2)} (Bs ${w.amountBs})</span><span class="badge text-cyan">Pendiente</span></div>`;
            });
            html += `</div>`;
        }
        html += `</div>`;
        walletEl.innerHTML = html;
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
        const [trips, users, transactions, config, recharges, withdrawals] = await Promise.all([
            API.get('/api/trips'), API.get('/api/users'), API.get('/api/transactions'),
            API.get('/api/config'), API.get('/api/wallet/recharges'), API.get('/api/wallet/withdrawals')
        ]);
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
        let html = '<table class="table"><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Vehiculo</th><th>Billetera</th><th>Rating</th></tr></thead><tbody>';
        users.forEach(u => {
            const vt = u.role === 'conductor' ? `${u.vehicle?.type === 'moto' ? '🏍️' : '🚗'} ${u.vehicle?.brand} ${u.vehicle?.model}` : '-';
            const avg = u.ratings?.length > 0 ? (u.ratings.reduce((a, b) => a + b, 0) / u.ratings.length).toFixed(1) : '-';
            html += `<tr><td><strong>${u.name}</strong></td><td>${u.email}</td><td><span class="badge ${u.role === 'conductor' ? 'text-purple' : 'text-cyan'}">${u.role.toUpperCase()}</span></td><td>${vt}</td><td class="font-bold text-emerald">$${(u.balance || 0).toFixed(2)} <span class="text-xs text-gray">Bs ${this.toBs(u.balance || 0)}</span></td><td>${avg !== '-' ? this.renderStarsSmall(avg, u.ratings.length) : '-'}</td></tr>`;
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

        this.renderAdminSupport(recharges, withdrawals);
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
            html += '<table class="table"><thead><tr><th>ID</th><th>Conductor</th><th>Monto</th><th>Cuenta</th><th>Estado</th><th>Accion</th></tr></thead><tbody>';
            withdrawals.forEach(w => {
                const statusColor = w.status === 'aprobada' ? 'text-emerald' : w.status === 'rechazada' ? 'text-red' : 'text-cyan';
                const bInfo = JSON.parse(w.bankInfo || '{}');
                html += `<tr>
                    <td class="text-xs font-mono">${w.id.slice(-8)}</td>
                    <td><strong>${w.conductorName}</strong></td>
                    <td class="font-bold text-emerald">$${w.amount.toFixed(2)} <span class="text-xs">Bs ${this.toBs(w.amount)}</span></td>
                    <td class="text-xs">${bInfo.bank || '-'} ${bInfo.account || ''}</td>
                    <td><span class="badge ${statusColor}">${w.status.toUpperCase()}</span></td>
                    <td>${w.status === 'pendiente' ? `<div class="flex gap-1"><button onclick="App.adminReviewWithdrawal('${w.id}', 'aprobada')" class="btn btn-emerald btn-sm">✓</button><button onclick="App.adminReviewWithdrawal('${w.id}', 'rechazada')" class="btn btn-red btn-sm">✗</button></div>` : '<span class="text-xs text-gray">' + (w.adminNote || 'Revisado') + '</span>'}</td>
                </tr>`;
            });
            html += '</tbody></table>';
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
        settingsEl.innerHTML = html;
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

    logout() {
        this.stopPendingTimer();
        localStorage.removeItem('turides_session');
        this.session = null;
        this.route();
        this.showToast('Sesion cerrada.', 'info');
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

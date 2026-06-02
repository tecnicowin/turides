# TuRides - Log de Cambios y Estado del Proyecto

## Estado Actual
- **Version**: 1.5.0
- **Ultimo commit**: pendiente
- **GitHub**: https://github.com/tecnicowin/turides
- **Deploy**: https://turides.onrender.com
- **Fecha**: 2026-06-02

## Archivos Principales
- `server.js` - Backend Express + Socket.io + better-sqlite3 + otpauth + qrcode
- `app.js` - Frontend SPA (logica cliente, conductor, admin)
- `index.html` - Todas las vistas HTML
- `style.css` - Estilos completos (dark theme glassmorphism)
- `package.json` - Dependencias (incluye otpauth, qrcode)
- `render.yaml` - Config deploy Render
- `turides.db` - Base de datos SQLite (generada en runtime)

## Cuentas Demo
> **IMPORTANTE**: Tras el setup inicial, la cuenta admin se crea desde la app (primer login).
> Las cuentas demo se usan solo si NO se ha completado el setup.

---

## Changelog Completo

### v1.5.0 - 2026-06-02

#### Seguridad: Setup Inicial del Administrador
- **Flujo de primer login**: Al abrir la app sin admin, muestra pantalla de configuración
- Admin crea su cuenta con nombre, email, teléfono y contraseña segura
- La contraseña se guarda con `passwordChanged = 1` para indicar setup completado
- Endpoint `GET /api/setup/status` verifica si ya existe admin configurado
- Endpoint `POST /api/setup/admin` crea el primer admin (solo funciona si no hay admin)

#### Seguridad: Cambio de Contraseña
- Panel de "Seguridad de mi Cuenta" en todos los roles (admin, cliente, conductor)
- Cambio de contraseña con validación de contraseña actual
- Endpoint `POST /api/change-password` con protección de重複

#### Seguridad: Autenticación 2FA (TOTP)
- Integración con **otpauth** + **qrcode** para generar códigos TOTP
- Compatible con **Authy**, **Google Authenticator**, **Microsoft Authenticator**
- Flujo completo:
  1. Usuario solicita activar 2FA → se genera secreto + QR code
  2. Escanea QR con app de autenticación
  3. Ingresa código de 6 dígitos para verificar
  4. 2FA se activa en la cuenta
- Login modificado: si 2FA activo, pide código antes de completar login
- Endpoint `POST /api/2fa/setup` genera secreto + QR
- Endpoint `POST /api/2fa/verify-and-enable` activa 2FA tras verificación
- Endpoint `POST /api/2fa/disable` desactiva 2FA (requiere contraseña)
- Endpoint `POST /api/login/2fa-verify` verifica código en login

#### Admin: Configuración Bancaria
- Panel "Configuración Bancaria y Seguridad" en admin dashboard
- Configurar datos bancarios para recibir recargas de clientes:
  - Banco (21 opciones venezolanas)
  - Número de cuenta
  - Titular
  - Tipo/Número de documento
  - Teléfono de contacto
- Estos datos se muestran a los clientes al solicitar recarga

#### Admin: Gestión de Retiros
- Panel de soporte con visualización de retiros de conductores
- Aprobar/rechazar solicitudes de retiro
- Al rechazar, se devuelve el saldo al conductor
- Notificaciones en tiempo real vía Socket.io

#### Real-time Balance
- Balance visible en navbar para clientes y conductores
- Actualización en tiempo real vía Socket.io `user:updated`
- Saldo en $ y Bs con tasa BCV actual

### v1.4.0 - 2026-06-02

#### Ajuste: Estructura de Costos Competitiva
- **Moto**: Base $0.80 + $0.20/km (antes $2.00 + $0.45/km)
- **Carro**: Base $1.80 + $0.50/km (antes $4.00 + $0.95/km)
- **Hora Pico**: +25% unicamente en horario vespertino 5pm-8pm (antes era +30% en 7-9am y 5-7pm)
- **Noche**: +20% de 10pm a 5am (sin cambio)
- **Diurno/Normal**: Sin recargo (sin cambio)
- Eliminado periodo "diurno" como separador, ahora solo normal/pico/noche
- Tarifas dentro del rango competitivo del mercado Venezolano

### v1.3.0 - 2026-06-01

#### Fix: Panel de Soporte Admin (commit b695529)
- `Promise.all` fallaba completamente si cualquiera de las 6 llamadas API fallaba
- Agregado `.catch(() => [])` individual a `/api/wallet/recharges` y `/api/wallet/withdrawals`
- Agregado try/catch general en `renderAdminDashboard`
- Agregado try/catch en `renderAdminSupport`
- Resultado: el dashboard admin ahora se renderiza aunque una API falle

#### Fix: Boton Cancelar y Logout (commit ce9cf5e)
- **Bug critico**: `stopPendingTimer()` era llamada 4 veces pero NUNCA fue definida en el rewrite del app.js
- Esto causaba TypeError que rompia `cancelTrip()` y `logout()`
- Solucion: Agregada la funcion `stopPendingTimer()` completa
- `cancelTrip()` ahora es `async` y hace `await` al API call antes de refrescar la vista

#### Fix: Sintaxis JS que impedia login (commit 6629663)
- Faltaban comillas de cierre en dos objetos `fareLabels` en lineas 343 y 427
- `' (Noche +20%)` -> `' (Noche +20%)'`
- Esto causaba que el JS entero no cargara, impidiendo TODO: login, logout, cancelar, aceptar viajes

### v1.2.0 - 2026-06-01

#### Feature: Tarifas Dinamicas por Horario
- Hora Pico (7-9am, 5-7pm): +30% multiplicador
- Noche (10pm-5am): +20% multiplicador
- Diurna/Normal: sin recargo
- Indicador visual en navbar y busqueda de conductores
- Label "Tarifa Normal/Diurna/Hora Pico/Noche" en header de busqueda

#### Feature: Precios en Bs (Bolivares)
- Todos los montos muestran USD + Bs (tasa BCV)
- Tasa BCV guardada en tabla `config` de SQLite
- Admin actualiza diariamente desde panel
- `toBs(usd)` calcula conversion en toda la app

#### Feature: Recarga de Billetera (Cliente)
- Seccion "Configuracion & Billetera" en dashboard cliente
- Muestra datos Pago Movil de TuRides para transferir
- Cliente envia solicitud: monto, banco, referencia, telefono
- Solicitud queda en tabla `recharges` con status "pendiente"
- Admin aprueba/rechaza desde panel de soporte
- Al aprobarse, saldo se acredita automaticamente

#### Feature: Retiro de Billetera (Conductor)
- Vista de billetera con saldo disponible en $ y Bs
- Muestra cuenta bancaria registrada
- Boton para solicitar retiro a cuenta bancaria
- Solicitud en tabla `withdrawals` con status "pendiente"
- Admin aprueba/rechaza desde panel de soporte
- Si se rechaza, el saldo se devuelve al conductor

#### Feature: Panel de Soporte Admin
- Control de recargas de clientes (aprobar/rechazar)
- Control de retiros de conductores (aprobar/rechazar)
- Badge con cantidad de pendientes
- Tablas con historial completo

#### Feature: Tasa BCV Admin
- Input para actualizar tasa BCV (Bs por $1 USD)
- Se aplica a todas las transacciones de la plataforma
- Ultima actualizacion visible

#### Fix: Tarifas Moto Corregidas
- minDistance: 2.5km (antes 2.0km)
- perKm: $0.45 (antes $0.50)
- Base: $2.00 (sin cambio)
- Ahora consistente con tabla de Tarifas.txt

#### DB Changes
- Nuevas tablas: `recharges`, `withdrawals`
- Nueva columna `bankInfo` en tabla `users`
- Nuevas columnas en `trips`: `priceBs`, `fareMultiplier`, `farePeriod`
- Nueva columna en `transactions`: `amountBs`
- Migraciones automaticas con ALTER TABLE + try/catch

### v1.1.0 - 2026-05-31

#### Fix: Botones de seleccion no se resaltaban
- Botones de Moto, Pago Movil y tipo de vehiculo no mostraban estado "selected"
- Agregados event listeners para togglear clase `selected` en radio buttons

#### Fix: SQLite para Render
- Migrado de db.json (ephemeral) a better-sqlite3 (persiste en memoria)
- WAL mode habilitado
- Datos seed con 9 usuarios (1 admin, 2 clientes, 6 conductores)
- Tabla `config` con datos de cuenta TuRides

### v1.0.0 - 2026-05-30

#### Feature: App Base TuRides
- Login/Register para cliente, conductor, admin
- Busqueda de conductores por tipo (carro/moto)
- Sistema de contratacion con estados
- Pago por RKM wallet o Pago Movil
- Calificacion bidireccional estrellas 1-5
- Dashboard admin con estadisticas
- Socket.io para sync en tiempo real
- Conductor polling cada 3s como fallback
- CSS dark theme glassmorphism mobile-responsive

---

## Estructura de Base de Datos

### Tabla `users`
```
id TEXT PK, name TEXT, phone TEXT, email TEXT UNIQUE, password TEXT,
role TEXT, available INTEGER, vehicle TEXT, tariffMode TEXT,
fixedTariffs TEXT, balance REAL, ratings TEXT, bankInfo TEXT
```

### Tabla `trips`
```
id TEXT PK, clientId TEXT, clientName TEXT, clientPhone TEXT,
originAddress TEXT, destinationAddress TEXT, distance REAL,
conductorId TEXT, conductorName TEXT, conductorPhone TEXT, conductorVehicle TEXT,
price REAL, priceBs REAL, paymentMethod TEXT, status TEXT,
paymentStatus TEXT, clientRating INTEGER, conductorRating INTEGER,
clientRatingAt TEXT, conductorRatingAt TEXT, createdAt TEXT,
completedAt TEXT, paymentVerifiedAt TEXT, fareMultiplier REAL, farePeriod TEXT
```

### Tabla `transactions`
```
id TEXT PK, tripId TEXT, clientId TEXT, conductorId TEXT,
amount REAL, amountBs REAL, method TEXT, status TEXT,
reference TEXT, phone TEXT, bankCode TEXT, createdAt TEXT
```

### Tabla `recharges`
```
id TEXT PK, userId TEXT, userName TEXT, amount REAL, amountBs REAL,
phone TEXT, bankCode TEXT, reference TEXT, status TEXT,
adminNote TEXT, createdAt TEXT, reviewedAt TEXT
```

### Tabla `withdrawals`
```
id TEXT PK, conductorId TEXT, conductorName TEXT, amount REAL, amountBs REAL,
bankInfo TEXT, status TEXT, adminNote TEXT, createdAt TEXT, reviewedAt TEXT
```

### Tabla `config`
```
key TEXT PK, value TEXT
```
Keys: bankName, accountNumber, accountType, documentType, documentNumber,
phone, holderName, bcvRate, bcvLastUpdate

---

## Tarifas Configuradas (v1.4.0)

| Parametro | Moto | Carro |
|-----------|------|-------|
| Base fija | $0.80 | $1.80 |
| Por km | $0.20 | $0.50 |
| Minimo (0-2.5km) | $0.80 | $1.80 |

**Multiplicadores por horario**:
- Normal: x1.0 (sin recargo)
- Hora Pico Vespertina (5pm-8pm): +25% (x1.25)
- Noche (10pm-5am): +20% (x1.20)

### Ejemplos de precios
| Distancia | Moto Normal | Moto Pico | Carro Normal | Carro Pico |
|-----------|-------------|-----------|--------------|------------|
| 2.5 km | $0.80 | $1.00 | $1.80 | $2.25 |
| 5 km | $1.30 | $1.63 | $3.05 | $3.81 |
| 10 km | $2.30 | $2.88 | $5.55 | $6.94 |
| 15 km | $3.30 | $4.13 | $8.05 | $10.06 |

---

## Endpoints API

### Auth
- POST /api/login
- POST /api/register

### Users
- GET /api/users
- GET /api/users/:id
- PUT /api/users/:id

### Conductors
- GET /api/conductors/available?distance=&vehicleType=

### Trips
- GET /api/trips
- POST /api/trips
- PUT /api/trips/:id/status
- PUT /api/trips/:id/rating

### Config
- GET /api/config
- PUT /api/config
- GET /api/rkm-config
- GET /api/fare-info

### Payments
- POST /api/payments/rkm
- POST /api/payments/pago_movil
- POST /api/rkm/recharge (instant - old flow)

### Wallet (nuevo)
- POST /api/wallet/recharge (solicitud con admin approval)
- GET /api/wallet/recharges
- PUT /api/wallet/recharges/:id
- POST /api/wallet/withdraw
- GET /api/wallet/withdrawals
- PUT /api/wallet/withdrawals/:id

### Transactions
- GET /api/transactions

### Socket.io Events
- trip:created, trip:new_request, trip:status_changed, trip:rated
- payment:completed, user:updated, user:created
- config:updated, recharge:created, recharge:approved, recharge:updated
- withdrawal:created, withdrawal:approved, withdrawal:rejected

---

## Pendientes / TODO

### Funcionalidad
- [ ] Integrar mapa real (Google Maps / Mapbox) para calcular distancia real
- [ ] Notificaciones push para moviles
- [ ] Historial detallado de viaje completado
- [ ] Funcion "rebook" rapido para clientes
- [ ] Chat entre cliente y conductor
- [ ] Modo oscuro / claro toggle
- [ ] Multi-idioma (ES/EN)

### Admin
- [ ] Admin puede deshabilitar/conductores
- [ ] Graficos de ventas diarias/semanales
- [ ] Exportar datos a CSV/Excel
- [ ] Notificaciones al admin cuando hay solicitudes pendientes

### Pagos
- [ ] Validar referencias de Pago Movil automaticamente
- [ ] Integrar pasarela de pago real
- [ ] Historial de transacciones con filtros por fecha
- [ ] Comprobante de pago descargable

### Conductor
- [ ] Historial de ganancias diarias/semanales
- [ ] Calculo automatico de kilometros con GPS
- [ ] Modo "en ruta" con ubicacion compartida

### Cliente
- [ ] Guardar direcciones frecuentes
- [ ] Calcular ruta real con Google Maps
- [ ] Compartir ubicacion del conductor en tiempo real

### Deploy
- [ ] Upgrade Render a plan de pago para evitar cold start
- [ ] Configurar dominio personalizado
- [ ] SSL/HTTPS automatico
- [ ] Backup automatico de base de datos

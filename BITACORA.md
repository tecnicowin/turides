# Bitacora de Desarrollo - TuRides

## Ultima actualizacion: 3 de Junio 2026

---

## Estado Actual del Proyecto

### Stack
- **Backend:** Express + Socket.io + PostgreSQL (Neon)
- **Frontend:** SPA vanilla JS (`app.js`)
- **Deploy:** Render (auto-deploy desde GitHub main)
- **DB:** Neon PostgreSQL (cloud) con PITR 6 horas

### Repositorio
- GitHub: `tecnicowin/turides`
- Branch: `main`

---

## Funcionalidades Implementadas

### 1. Sistema de Usuarios
- 3 roles: Cliente, Mensajero, Conductor (+ Admin)
- Registro con seleccion de vehiculo para conductores
- Login con 2FA TOTP (Google Authenticator/Authy)
- Cambio de contrasena desde cualquier pantalla
- First-time admin setup (cuando no hay admin en DB)

### 2. Tipos de Vehiculo (7)
| Tipo | Tarifa Base | Por Km | Distancia |
|------|------------|--------|-----------|
| 🚗 Carro | $1.80 | $0.50/km | Min 2.5 km |
| 🚙 Camioneta | $4.50 | $0.90/km | Min 2.5 km |
| 🏍️ Moto | $0.80 | $0.40/km | Min 2.5 km |
| 🛵 Moto Delivery | $1.80 | $0.55/km | Min 2.5 km |
| 🚶 Mensajero | $0.50 | $1.00/km | Max 3.0 km |
| 🛻 Mudanza Pick-Up | $50 | Fijo | 1 ton |
| 🚛 Mudanza 350 | $100 | Fijo | 3.5 ton |
| 🚚 Mudanza 750 | $180 | Fijo | 7 ton |

### 3. Sistema de Pagos
- **Billetera RKM:** Pago instantaneo al completar viaje
- **Pago Movil:** Transferencia bancaria directa al conductor
- **Efectivo:** Solo para mudanza
- **Recarga:** Solicitud pendiente de aprobacion del admin

### 4. Recargos por Horario
- Normal: 5:00 AM - 4:59 PM (sin recargo)
- Hora Pico: 5:00 PM - 7:59 PM (+25%)
- Noche: 10:00 PM - 4:59 AM (+20%)

### 5. Sistema de Comisiones

#### Comision por Viaje (Plataforma)
| Servicio | Comision |
|----------|----------|
| Carro, Camioneta, Moto, Moto Delivery, Mensajero | **10%** |
| Mudanza Pick-Up | **5%** |
| Mudanza 350 | **10%** |
| Mudanza 750 | **15%** |

#### Comision por Retiro (Gastos de Plataforma)
- Configurable por admin (default **10%**)
- Se aplica al retirar dinero a cuenta bancaria
- Mudanza: **0%** (ya cobro comision en viaje)

#### Liquidacion en Panel Admin
- **Comision Viajes** - Total comisiones de operaciones
- **Comision Retiros** - Total comisiones de retiros
- **Total Liquidacion** - Suma de ambas

### 6. Panel de Admin
- Stats: Servicios, Completados, Volumen, Comision Viajes, Comision Retiros, Total Liquidacion
- Gestion de usuarios (ver lista, billetera, 2FA, rating)
- Aprobacion/Rechazo de recargas de clientes
- Aprobacion/Rechazo de retiros de conductores
- Verificacion de pagos movil
- Configuracion de tasa BCV
- Configuracion de cuenta bancaria del admin
- Reporte diario con print/PDF
- Backup: manual JSON, Google Drive, 7-day reminder, Neon PITR
- **Collapse/expand** en secciones de recargas, retiros y viajes (ultimos 5 por defecto)

### 7. Panel del Cliente
- Busqueda de conductores por tipo de vehiculo
- Vista activa del viaje en curso
- Historial de solicitudes (collapse, ultimas 5)
- Billetera con recarga (modal con datos del admin + solicitud pendiente)
- Historial de recargas (collapse, ultimas 5)
- Calificacion de conductores (1-5 estrellas)
- Seguridad: cambio de contrasena + 2FA
- **Boton "+"** junto al saldo RKM abre modal de recarga completa

### 8. Panel del Conductor
- Toggle de disponibilidad
- Solicitud entrante con aceptar/rechazar
- Vista del viaje activo con proceso de pago
- Billetera con retiros (show more, ultimos 3)
- Configuracion de cuenta bancaria (21 bancos)
- Calificacion de clientes
- Seguridad: cambio de contrasena + 2FA

### 9. Panel del Mensajero
- Similar al conductor pero con dashboard independiente
- Servicios: Documentos, Paquetes, Botellones, Retiro de Compras
- Toggle de disponibilidad
- Solicitud entrante con aceptar/rechazar
- Billetera con retiros inline
- Configuracion de cuenta bancaria (26 bancos)

### 10. Mudanza
- 3 sub-tipos: Pick-Up (1 ton), 350 (3.5 ton), 750 (7 ton)
- Tarifa fija por tipo
- 3 metodos de pago: Billetera, Efectivo, Pago Movil
- Comision de plataforma descontada al conductor
- Validacion de saldo del conductor para aceptar
- Admin verifica pagos movil

### 11. Sistema de Notificaciones (Socket.io)
- `trip:created`, `trip:status_changed`, `trip:new_request`
- `user:updated` - Actualiza billetera en tiempo real
- `recharge:created` - Admin recibe notificacion
- `recharge:approved` - Cliente recibe actualizacion
- `recharge:updated` - Admin refresca dashboard
- `withdrawal:created`, `withdrawal:realized`, `withdrawal:rejected`
- `payment:completed`
- Conductor polling cada 3s como fallback

### 12. Geolocalizacion
- Nominatim geocoding + formula Haversine
- Factor de ruta 1.35
- Fallback a distancia estimada cuando falla geocoding

### 13. Ayuda/Guia
- Guia completa en español
- Soporte print/PDF con boton 🖨️
- Roles: Cliente, Conductor, Mensajero, Admin

### 14. Logo
- `images/logo.png` - navbar (32x32), login (120x120), setup

---

## Lista de Bancos Oficiales BCV (26)

```
0102 - Banco de Venezuela
0104 - Venezolano de Credito
0105 - Mercantil Banco
0108 - BBVA Provincial
0114 - Bancaribe
0115 - Banco Exterior
0128 - Banco Caroni
0134 - Banesco
0137 - Banco Sofitasa
0138 - Banco Plaza
0146 - Bangente
0151 - BFC Banco Fondo Comun
0156 - 100% Banco
0157 - DelSur Banco Universal
0163 - Banco del Tesoro
0166 - Banco Agricola de Venezuela
0168 - Bancrecer
0169 - R4 Banco Microfinanciero
0171 - Banco Activo
0172 - Bancamiga
0173 - Banco Internacional
0174 - Banplus
0175 - Banco Digital de Los Trabajadores
0177 - Banco de la Fuerza Armada
0178 - N58 Banco Digital
0191 - Banco Nacional de Credito
```

---

## Arquitectura de Archivos

```
TuRides/
├── server.js          # Express + Socket.io + PostgreSQL
├── app.js             # Client SPA (all UI logic)
├── index.html         # HTML views
├── style.css          # All styles
├── db.js              # PostgreSQL pool wrapper
├── package.json       # Dependencies
├── render.yaml        # Render build config
├── .gitignore         # Ignores turides.db, node_modules
├── BITACORA.md        # Este archivo
└── images/
    └── logo.png       # TuRides logo
```

---

## Variables de Entorno (Render)

- `DATABASE_URL` - Neon PostgreSQL connection string
- `GOOGLE_DRIVE_CREDENTIALS` - Service Account JSON
- `GOOGLE_DRIVE_FOLDER_ID` - Folder ID for backups

---

## Base de Datos (PostgreSQL)

### Tablas
- `users` - Usuarios con roles, billetera, 2FA, bankInfo
- `trips` - Viajes con orderdetails, platformcommission
- `transactions` - Transacciones de billetera
- `config` - Configuracion del admin (BCV rate, bank details)
- `recharges` - Solicitudes de recarga de clientes
- `withdrawals` - Solicitudes de retiro de conductores

### Convenciones
- Todas las columnas en **lowercase** (PostgreSQL requirement)
- Mapeo a camelCase en JS con `mapRow()` y `USER_MAP`, `TRIP_MAP`, etc.
- `CREATE TABLE IF NOT EXISTS` (no DROP para preservar datos)

---

## Commits Recientes

```
4619339 - Lista bancos oficial BCV 26 bancos. Constante BANKS global
fe7cc00 - Fix: grid-4 to 6 columns for liquidacion cards
7c7a5df - Liquidacion: desglose comision viajes + retiros + total
```

---

## Pendiente / Ideas Futuras

- [ ] Notificaciones push (actualmente solo Socket.io)
- [ ] Mapa en tiempo real de ubicacion del conductor
- [ ] Sistema de quejas/reclamaciones
- [ ] Multi-idioma (es/en)
- [ ] Modo oscuro/claro
- [ ] App movil (React Native / Flutter)

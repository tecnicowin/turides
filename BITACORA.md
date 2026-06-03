# Bitácora de Desarrollo - TuRides

## Última sesión: 03/Junio/2026 11:00 PM

---

## ✅ Completado esta sesión

### FIX CRÍTICO: Pérdida de datos en cada deploy
**Problema:** `initDB()` ejecutaba `DROP TABLE IF EXISTS` en todas las tablas cada vez que el servidor arrancaba. En Render, esto ocurría en cada deploy, sleep/wake, o restart.

**Solución:** Eliminado el loop `DROP TABLE` y cambiado `CREATE TABLE` a `CREATE TABLE IF NOT EXISTS`. Ahora las tablas se crean solo si no existen, y los datos persisten entre deploys.

**Archivo:** `server.js:60-113` — función `initDB()`

**Commits:**
- `9cee818` — FIX: Remove DROP TABLE from initDB - data now persists across deploys
- `c2ca899` — Add admin backup/restore system (JSON export/import)
- `c09198e` — FIX: backup/restore auth - use x-user-id header instead of undefined middleware
- `23d10a3` — Add backup reminder + Google Drive auto-upload
- `83ebea9` — Add Walking Courier (Mensajero) service with digital orders
- `c1cffdd` — Add Mudanza service (Pick-Up, 350, 750) with sub-type selection

### Servicio Walking Courier (Mensajero)
- **Tipo de vehículo:** `mensajero` (🚶)
- **Tarifa:** $1.50 base (0-1 km) + $1.00/km adicional, máximo 2 km
- **Servicios:** Documentos, Paquetes (<2kg), Botellones de Agua, Retiro de Compras
- **Orden digital:** Se genera `MENS-[ID]` con datos del remitente, destinatario, tipo de servicio y descripción
- **Flujo:** Cliente llena formulario de envío → Conductor acepta → Muestra orden al retirar paquete
- **Archivos:** `server.js` (rate + orderdetails), `app.js` (UI + form), `index.html` (radio + form)

### Servicio Carga/Mudanza
- **Tipo de vehículo:** `mudanza` (🚚)
- **Sub-tipo:** Seleccionable desde dropdown
  - Pick-Up (1 ton): $50 flat
  - Camión 350 (3.5 ton): $100 flat
  - Camión 750 (7 ton): $180 flat
- **Tarifa:** Flat rate (sin cargo por km)
- **Orden digital:** Incluye sub-tipo, descripción, datos del solicitante
- **Flujo:** Cliente selecciona "Carga/Mudanza" → Elige sub-tipo → Contrata → Conductor acepta → Muestra orden

### Sistema de Backup/Restauración
- **Endpoint GET `/api/admin/backup`**: Exporta todos los datos (users, trips, transactions, config, recharges, withdrawals) como archivo JSON descargable
- **Endpoint POST `/api/admin/restore`**: Importa datos desde un archivo JSON con upsert (ON CONFLICT DO UPDATE/DO NOTHING)
- **Endpoint GET `/api/admin/backup/status`**: Trackea último backup y si necesita crear uno nuevo
- **Endpoint POST `/api/admin/backup/track`**: Marca fecha del último backup
- **Endpoint POST `/api/admin/backup/google-drive`**: Sube backup automáticamente a Google Drive
- **UI Admin**: 3 botones — Descargar, Subir a Google Drive, Restaurar
- **Recordatorio**: Banner amarillo cada 7 días sin backup
- **Seguridad**: Solo admin puede usar estos endpoints
- **Transacción SQL**: Restore usa BEGIN/COMMIT/ROLLBACK para garantizar integridad

### Configuración Google Drive (pendiente)
- Variable de entorno `GOOGLE_DRIVE_CREDENTIALS`: JSON de Service Account
- Variable de entorno `GOOGLE_DRIVE_FOLDER_ID` (opcional): ID de carpeta destino
- Ver instrucciones en la sección de setup de Google Drive

---

## ✅ Completado esta sesión

### Tarifas por categorías de vehículo
Se actualizaron las tarifas basadas en datos de mercado venezolano:

| Categoría | Tarifa Base | Por Km | Dist. Mín. | Ícono |
|-----------|------------|--------|------------|-------|
| Moto (Transporte) | $0.80 | $0.40/km | 2.5 km | 🏍️ |
| Moto Delivery | $1.80 | $0.55/km | 2.5 km | 🛵 |
| Carro | $1.80 | $0.50/km | 2.5 km | 🚗 |
| Camioneta (Confort) | $4.50 | $0.90/km | 2.5 km | 🚙 |

**Archivos modificados:**
- `server.js`: Línea ~38-43 — `KILOMETER_RATE` actualizado con 4 categorías
- `app.js`: Línea ~1 — `KILOMETER_RATE_CONFIG` actualizado con 4 categorías
- `app.js`: Línea ~1196 — Icono del admin table usa `vIcons` con 4 tipos
- `index.html`: Radio buttons en registro y búsqueda con 4 opciones en grid 2x2
- `app.js`: Texto de ayuda actualizado con 4 categorías

### Logo de TuRides
Se agregó imagen `images/logo.png` en 3 ubicaciones:

**Archivos modificados:**
- `index.html`: Navbar (32x32), Login (120x120 con sombra púrpura), Setup (120x120 con sombra púrpura)
- `style.css`: Estilos `.nav-logo`, `.brand-logo-container`, `.brand-logo`

**Imagen:** `D:\TuRides\images\logo.png` (674 KB)
**Copia fuente:** `D:\TuRides\images\96c06f71.png`

### Commits realizados
1. `ec5da3e` — Add camioneta and moto_delivery categories with market-based fares
2. `b715156` — Add TuRides logo to navbar, login, and setup pages
3. `37f87e4` — Update logo image

---

## 📋 Pendientes para próxima sesión

### Funcionalidades a revisar
- [ ] Verificar flujo completo: Admin setup → login → 2FA → cliente busca viaje (4 tipos) → conductor acepta → pago RKM → calificación
- [ ] Verificar que los filtros de búsqueda por tipo de vehículo funcionan correctamente
- [ ] Probar que el cálculo de tarifas usa las nuevas tasas
- [ ] Verificar que los conductores pueden seleccionar Camioneta o Moto Delivery al registrarse
- [ ] Test de ayuda/guía con las nuevas categorías

### Mejoras pendientes
- [ ] Agregar "Camioneta de Carga" (si aplica para TuRides)
- [ ] Actualizar tabla comparativa de tarifas en la guía de ayuda con las 4 categorías
- [ ] Considerar agregar descripción de capacidad por tipo de vehículo en la UI
- [ ] Revisar si hay otros archivos que mencionen "moto" solamente y necesiten actualizar a los 4 tipos

### Deploy
- Push automático a GitHub → Render deploy
- Verificar que Render está sirviendo la nueva imagen correctamente
- Verificar que `/images/logo.png` carga en producción

---

## 📊 Resumen del proyecto

- **Repositorio:** https://github.com/tecnicowin/turides
- **Deploy:** https://turides.onrender.com
- **Base de datos:** PostgreSQL (Neon)
- **Stack:** Express + Socket.io + PostgreSQL (pg) + SPA vanilla JS

### Estructura de archivos clave
```
D:\TuRides\
├── server.js          # Backend principal (API, Socket.io, tarifas)
├── app.js             # Frontend SPA (UI, wallet, admin, ayuda)
├── index.html         # Vistas HTML (setup, login, admin, registro)
├── style.css          # Estilos (1500+ líneas, incluye print)
├── db.js              # Wrapper PostgreSQL (Pool + helpers)
├── images/
│   ├── logo.png       # Logo principal (674 KB)
│   └── 96c06f71.png   # Copia fuente del logo
├── package.json
├── render.yaml
├── .gitignore
└── BITACORA.md        # Este archivo
```

### Variables de entorno en Render
- `DATABASE_URL` = Neon PostgreSQL connection string
- `NODE_ENV` = production

---

## 🔧 Comandos útiles

```bash
# Ver estado de git
git status

# Commit y push
git add .; git commit -m "mensaje"; git push

# Ver logs de Render
# Ir a: https://dashboard.render.com → TuRides → Logs

# Conectar a PostgreSQL directamente (si es necesario)
# Usar el connection string de Neon en DB Browser o pgAdmin
```

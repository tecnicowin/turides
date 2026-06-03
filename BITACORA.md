# Bitácora de Desarrollo - TuRides

## Última sesión: 02/Junio/2026 11:30 PM - 03/Junio/2026 12:30 AM

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

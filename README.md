# GastoCasa

**Control de gastos del hogar** — PWA instalable en móviles, sin servidor y 100 % offline. Diseño minimalista en grises y azul oscuro.

Tus datos se guardan únicamente en el dispositivo (IndexedDB). No hay cuentas, rastreo ni backend.

## Características

- **Varios usuarios del hogar**, con selector rápido de usuario activo.
- **Categorías editables** (nombre, icono, color y límite mensual). Al borrar una con gastos, se reasignan para no perder historial.
- **Dashboard** con estadísticas semanales (ISO, lunes a domingo), mensuales y anuales, gráfico SVG táctil y desglose por categoría.
- **Gastos con filtros:** buscador por nombre, categoría, usuario, rango de fechas, atajos (esta semana, este mes, mes pasado) y suma total de lo filtrado.
- **Saldos entre miembros** y botón para saldar cuentas sin alterar las estadísticas de gasto.
- **Registro rápido** (botón `+`) con teclado numérico y categoría en un toque.
- **Sincronización en la nube (Multi-móvil):** comparte gastos y miembros en tiempo real entre múltiples teléfonos usando una base de datos gratuita de **Supabase** (PostgreSQL REST).
- **Enlace de vinculación en 1 clic:** genera un enlace para compartir por WhatsApp; al abrirlo en el segundo móvil, se configura y sincroniza automáticamente sin tener que escribir claves.
- **Respaldo:** exportar/importar JSON y exportar CSV (Excel / Google Sheets).
- **PWA:** funciona sin conexión e instalable en Android e iOS.

## Probar en local

La app usa módulos ES, por lo que **no funciona abriendo `index.html` con doble clic** (`file://`). Hay que servirla por HTTP.

En Windows (sin instalar nada):

```powershell
powershell -ExecutionPolicy Bypass -File .\start-server.ps1
```

Abre `http://localhost:8080/`. Alternativas, si las tienes instaladas: `python -m http.server 8080` o `npx serve`.

## Publicar en GitHub Pages

1. Sube el proyecto a un repositorio en GitHub (rama `main`).
2. En el repositorio: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. El workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publica la app en cada push.
4. La URL será `https://<tu-usuario>.github.io/<nombre-del-repo>/` (GitHub Pages usa HTTPS, necesario para instalarla como PWA).

## Instalar en el móvil

- **Android (Chrome):** abre la URL y pulsa **Instalar** o menú ⋮ → *Instalar aplicación*.
- **iPhone (Safari):** botón **Compartir** → *Añadir a pantalla de inicio*.

## Estructura

```text
├── index.html              # Estructura y vistas
├── manifest.webmanifest    # Configuración PWA
├── sw.js                   # Service Worker (offline)
├── start-server.ps1        # Servidor local para Windows
├── css/
│   ├── brutalist-tokens.css  # Variables de diseño
│   ├── app.css               # Layout y componentes base
│   └── minimal-theme.css     # Tema minimalista (sobrescribe app.css)
├── js/
│   ├── models.js           # Modelos y valores por defecto
│   ├── db.js               # IndexedDB, respaldo y datos demo
│   ├── split-engine.js     # Cálculo en centavos, fechas ISO y saldos
│   ├── charts-svg.js       # Gráficos SVG
│   ├── pwa-install.js      # Service Worker, instalación y exportación
│   └── app.js              # Controlador principal
└── icons/                  # Iconos de la PWA
```

## Notas técnicas

- Sin dependencias ni paso de compilación.
- Al publicar cambios, sube el número de versión de `CACHE_NAME` en `sw.js` para que los usuarios reciban los archivos nuevos.
- Los iconos son SVG. Algunos dispositivos requieren PNG de 192×192 y 512×512 para la instalación; si hace falta, añádelos en `icons/` y refléjalos en `manifest.webmanifest`.

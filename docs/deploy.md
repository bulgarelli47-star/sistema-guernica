# Atlas OS — Guía de deploy productivo

## Prerequisitos en el VPS

```bash
# Node.js 20+, npm, git, PM2
apt update && apt install -y git
npm install -g pm2
```

## Primer setup

```bash
# 1. Clonar repositorio
git clone <repo-url> /root/sistema-guernica
cd /root/sistema-guernica

# 2. Instalar dependencias de producción
npm install --omit=dev

# 3. Crear archivo .env con variables reales
cp .env.example .env
nano .env   # completar MERCADOPAGO_ACCESS_TOKEN y cualquier variable adicional

# 4. Crear carpeta de logs
mkdir -p /var/log/atlas-os

# 5. Inicializar base de datos (solo primera vez)
node database/init-db.js

# ⚠️  IMPORTANTE: Cambiar la contraseña del usuario admin
#     antes de exponer el sistema públicamente.
#     El sistema crea admin/admin123 por defecto.

# 6. Iniciar con PM2
pm2 start ecosystem.config.js --env production

# 7. Persistir PM2 entre reinicios del servidor
pm2 save
pm2 startup   # seguir las instrucciones que imprime este comando
```

## Deploy normal (actualizaciones)

```bash
bash scripts/deploy.sh
```

Con override del directorio de la app:
```bash
APP_DIR=/ruta/alternativa bash scripts/deploy.sh
```

## Deploy con tests

```bash
RUN_TESTS=1 bash scripts/deploy.sh
```

Los tests levantan un servidor de prueba en puerto libre y corren contra
una copia temporal de la base de datos. No tocan la DB de producción.

## Backup manual

```bash
node scripts/backup-db.js
```

Los backups se guardan en `backups/` con nombre `guernica-YYYY-MM-DD_HH-MM-SS.db`.
Se rotan automáticamente conservando los últimos 30 (configurable con `GUERNICA_BACKUP_MAX`).

## Cron de backup diario (recomendado)

Agregar al crontab del servidor (`crontab -e`):

```
0 3 * * * cd /root/sistema-guernica && node scripts/backup-db.js --if-exists >> /var/log/atlas-os/backup.log 2>&1
```

Esto ejecuta un backup todos los días a las 3:00 AM.

## Variables de entorno disponibles

| Variable | Default | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `GUERNICA_DB_PATH` | `database/guernica.db` | Ruta alternativa a la DB SQLite |
| `GUERNICA_BACKUP_DIR` | `backups/` | Directorio de backups |
| `GUERNICA_BACKUP_MAX` | `30` | Cantidad máxima de backups a conservar |
| `MERCADOPAGO_ACCESS_TOKEN` | — | Token de Mercado Pago Point |

Todas se cargan desde el archivo `.env` en la raíz del proyecto.
El `.env` **nunca** debe subirse al repositorio (está en `.gitignore`).

## Logs con PM2

```bash
pm2 logs atlas-os          # logs en tiempo real
pm2 logs atlas-os --lines 100  # últimas 100 líneas
pm2 status                 # estado del proceso
pm2 restart atlas-os       # reiniciar manualmente
```

Los archivos de log están en:
- `/var/log/atlas-os/out.log` — salida estándar
- `/var/log/atlas-os/error.log` — errores

## Advertencias de seguridad

- **Cambiar la contraseña de admin** antes de exponer el sistema públicamente.
  El sistema inicializa con `admin` / `admin123`.
  Usar el panel de Usuarios para cambiarlo, o directamente desde `/usuarios/:id/cambiar-password`.

- **No commitear `.env`** — está en `.gitignore` pero verificar antes de cada push
  que no esté incluido accidentalmente (`git status`).

- **Rotar el token de Mercado Pago** si el `.env` fue expuesto en algún
  commit o log. Hacerlo desde el panel de Mercado Pago Developers.

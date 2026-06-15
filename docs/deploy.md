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

## Configuración de Nginx

Atlas OS requiere que Nginx esté configurado con un límite de body adecuado para
permitir la carga de imágenes. Las imágenes viajan como **base64 dentro de JSON**,
lo que incrementa el tamaño del request en ~33% respecto al archivo original.

> **¿Por qué importa?**
> El default de Nginx es `client_max_body_size 1m` (1 MB). Con ese valor,
> una imagen de 1 MB ya supera el límite al codificarse en base64 (~1.37 MB
> de payload JSON). Nginx devuelve HTTP 413 **antes** de que el request llegue
> a Express, por lo que el mensaje de error amigable del backend no llega al
> usuario — el browser recibe HTML de error de Nginx en su lugar.
>
> Express tiene configurado `express.json({ limit: "15mb" })` y un handler
> que devuelve JSON con mensaje legible si el 413 llega a Node.js. Para que
> ese handler funcione, Nginx debe dejar pasar el request.

### Bloque de configuración recomendado

```nginx
server {
    server_name atlasos.com.ar;  # reemplazar con el dominio real

    # Necesario para que las imágenes (base64/JSON) lleguen a Express.
    # Las imágenes están limitadas a 5 MB en el backend; 20M da margen
    # suficiente al overhead de base64 (~6.7 MB) + headers JSON.
    client_max_body_size 20M;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### Validar y recargar Nginx

Después de editar el archivo de configuración:

```bash
sudo nginx -t              # verificar sintaxis — debe decir "syntax is ok"
sudo systemctl reload nginx  # aplicar sin cortar conexiones activas
```

### Síntoma de Nginx mal configurado

Si al subir una imagen se recibe un error genérico de red (no el mensaje
"La imagen no puede superar 5 MB") o la respuesta tiene `Content-Type: text/html`
en lugar de `application/json`, revisar primero `client_max_body_size`.

---

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

---

## Hardening VPS aplicado

Estado verificado al 2026-06-15. Esta sección documenta el hardening de producción
ejecutado en el VPS. Actualizar cuando cambie el estado.

### Estado actual verificado

| Ítem | Estado |
|---|---|
| Dominio `atlasos.com.ar` con HTTPS | ✅ operativo |
| Certificado SSL vigente | ✅ activo |
| Nginx activo y configurado | ✅ |
| UFW activo | ✅ |
| Puerto 22 (SSH) permitido | ✅ |
| Puerto 80 (HTTP) permitido | ✅ |
| Puerto 443 (HTTPS) permitido | ✅ |
| Puerto 3000 bloqueado por firewall | ✅ solo accesible vía localhost |
| Node.js responde en `127.0.0.1:3000` | ✅ |
| PM2 proceso `atlas-os` corriendo | ✅ |
| `pm2 save` ejecutado | ✅ |
| `pm2 startup` configurado como `pm2-root` | ✅ |
| `pm2-logrotate` instalado y online | ✅ |
| Logs en `/var/log/atlas-os/` | ✅ |
| Backups locales funcionando | ✅ |
| `.env`, `uploads/`, `backups/`, `database/*.db`, `node_modules/` en `.gitignore` | ✅ |

### Comandos de verificación rápida

```bash
# Verificar firewall
ufw status verbose

# Verificar proceso PM2
pm2 list

# Verificar que HTTPS responde
curl -I https://atlasos.com.ar

# Backup manual
node scripts/backup-db.js

# Verificar logs en tiempo real
pm2 logs atlas-os --lines 50
```

### Configurar PM2 para sobrevivir reinicios (primer setup)

```bash
# Ejecutar una sola vez en el VPS
pm2 save
pm2 startup    # imprime un comando — ejecutarlo como indica

# Instalar rotación de logs
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

### Deploy en producción

```bash
# Opción A — script automatizado (recomendado)
bash scripts/deploy.sh

# Opción B — manual paso a paso
cd /root/sistema-guernica
git pull origin main
npm install --omit=dev
node --check backend/server.js
node scripts/test-stock-flows.js
pm2 restart atlas-os
pm2 save
```

El script `deploy.sh` ejecuta automáticamente: backup de DB → git pull → npm install →
syntax check → restart PM2.

### Nginx — configuración SSL completa

Certbot gestiona automáticamente el bloque SSL. El bloque resultante en
`/etc/nginx/sites-enabled/atlasos` incluye las directivas generadas por Certbot
más las personalizaciones manuales. Después de cualquier cambio en Nginx:

```bash
sudo nginx -t                   # verificar sintaxis
sudo systemctl reload nginx     # aplicar sin cortar conexiones
certbot renew --dry-run         # verificar renovación automática del certificado
```

### Pendientes de hardening

Estos ítems están **pendientes** — no se aplicaron aún. Ordenados por prioridad.

#### Alta prioridad

- [ ] **Usuario no-root** — crear usuario `deploy` y mover la app de `/root/sistema-guernica`
  a `/home/deploy/sistema-guernica`. Actualizar `deploy.sh` con el nuevo `APP_DIR`.
  ```bash
  adduser deploy
  mkdir -p /home/deploy/sistema-guernica
  # copiar app, ajustar permisos, actualizar crontab
  ```

- [ ] **SSH por clave, sin password** — copiar clave pública al VPS, luego en
  `/etc/ssh/sshd_config` establecer `PasswordAuthentication no` y `PermitRootLogin no`.
  > ⚠️ Verificar acceso con clave en una segunda sesión antes de cerrar la primera.

#### Media prioridad

- [ ] **Backup remoto** — sincronizar `backups/` a S3, Backblaze B2 u otro servidor.
  Los backups locales no protegen contra pérdida del VPS completo.
  ```bash
  # Ejemplo con rsync a otro servidor
  rsync -avz /root/sistema-guernica/backups/ user@backup-server:/backups/atlasos/
  ```

- [ ] **Test de restore** — ejecutar un restore real desde un backup para verificar
  que el proceso funciona antes de necesitarlo en emergencia.
  ```bash
  # Copiar backup a ruta temporal y verificar que la DB es legible
  cp backups/guernica-YYYY-MM-DD_HH-MM-SS.db /tmp/guernica-test.db
  sqlite3 /tmp/guernica-test.db "SELECT COUNT(*) FROM ventas;"
  ```

- [ ] **Backup de uploads** — las imágenes de productos y usuarios en `uploads/`
  no se incluyen en el backup de DB. Agregar al proceso de sincronización remota.

#### Baja prioridad / mejora futura

- [ ] **Monitoreo básico** — configurar UptimeRobot o similar para alertas si
  `https://atlasos.com.ar` deja de responder.

- [ ] **Header `X-Powered-By`** — Express expone `X-Powered-By: Express` por defecto.
  Evaluar agregar `app.disable('x-powered-by')` o instalar `helmet` en el backend
  para ocultar información del stack.

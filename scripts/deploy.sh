#!/bin/bash
set -e

APP_DIR="${APP_DIR:-/root/sistema-guernica}"
LOG_DIR="/var/log/atlas-os"

echo ""
echo "========================================="
echo "  Atlas OS — Deploy $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="
echo "  APP_DIR: $APP_DIR"
echo ""

# 1. Crear directorio de logs si no existe
mkdir -p "$LOG_DIR"

# 2. Ir al directorio de la app
cd "$APP_DIR"

# 3. Backup antes de cualquier cambio
echo "[1/6] Backup de base de datos..."
node scripts/backup-db.js --if-exists
echo "      OK"

# 4. Pull de cambios
echo "[2/6] Git pull origin main..."
git pull origin main
echo "      OK"

# 5. Instalar dependencias de producción
echo "[3/6] npm install..."
npm install --omit=dev
echo "      OK"

# 6. Verificar sintaxis de archivos críticos
echo "[4/6] Verificando sintaxis..."
node --check backend/server.js
node --check backend/services/stockService.js
node --check backend/services/finanzasService.js
node --check scripts/test-stock-flows.js
echo "      OK"

# 7. Tests opcionales (RUN_TESTS=1 bash scripts/deploy.sh)
if [ "${RUN_TESTS}" = "1" ]; then
  echo "[5/6] Corriendo tests (RUN_TESTS=1)..."
  node scripts/test-stock-flows.js
  echo "      OK"
else
  echo "[5/6] Tests omitidos (pasar RUN_TESTS=1 para correrlos)"
fi

# 8. Reiniciar o iniciar con PM2
echo "[6/6] Reiniciando PM2..."
pm2 restart atlas-os || pm2 start ecosystem.config.js --env production
echo "      OK"

echo ""
echo "========================================="
echo "  Deploy completado: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="
echo ""

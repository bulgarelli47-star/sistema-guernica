// WORKER-OPS-1: los workers del outbox central (rol_activo y password) son procesos SEPARADOS del
// servidor HTTP y solo se declaran con el flag operativo explicito ATLAS_WORKERS_ENABLED=1 en el
// entorno de `pm2 start`. Sin el flag (deploy single/legacy actual) PM2 levanta unicamente atlas-os,
// exactamente como antes. Con el flag, los workers heredan el entorno del proceso PM2 y exigen
// ATLAS_AUTH_MODE=central, ATLAS_TENANCY_MODE=multi, ATLAS_USER_BRIDGE_MODE=shadow y
// ATLAS_CONTROL_DB_PATH absoluto existente; ante configuracion invalida salen con codigo 2, que PM2 NO
// reintenta (stop_exit_codes) para no entrar en crash-loop.
// Siempre UNA instancia por worker (fork, sin cluster). `pm2 stop` envia SIGINT: el worker no toma un
// ciclo nuevo, espera que termine el ciclo en curso y sale (kill_timeout acota la espera). Procedimiento
// de BACKUP-1: detener servidor + workers -> snapshot -> levantar.
const atlasOs = {
  name: "atlas-os",
  script: "backend/server.js",
  instances: 1,
  autorestart: true,
  watch: false,
  max_memory_restart: "500M",

  env: {
    NODE_ENV: "production",
    PORT: 3000
    // GUERNICA_DB_PATH y MERCADOPAGO_ACCESS_TOKEN se toman del archivo .env
    // ubicado en la raíz del proyecto (nunca subir al repositorio)
  },

  out_file: "/var/log/atlas-os/out.log",
  error_file: "/var/log/atlas-os/error.log",
  log_date_format: "YYYY-MM-DD HH:mm:ss",
  merge_logs: true
};

function worker(name, script, logBase) {
  return {
    name,
    script,
    args: "--watch",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    stop_exit_codes: [2],
    min_uptime: "10s",
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 30000,
    max_memory_restart: "200M",
    env: {
      NODE_ENV: "production"
    },
    out_file: `/var/log/atlas-os/${logBase}-out.log`,
    error_file: `/var/log/atlas-os/${logBase}-error.log`,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true
  };
}

const workersHabilitados = process.env.ATLAS_WORKERS_ENABLED === "1";

module.exports = {
  apps: [
    atlasOs,
    ...(workersHabilitados
      ? [
          worker("atlas-rol-activo-worker", "database/run-rol-activo-worker.js", "rol-activo-worker"),
          worker("atlas-password-worker", "database/run-password-worker.js", "password-worker")
        ]
      : [])
  ]
};

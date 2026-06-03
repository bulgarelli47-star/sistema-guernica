module.exports = {
  apps: [
    {
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
    }
  ]
};

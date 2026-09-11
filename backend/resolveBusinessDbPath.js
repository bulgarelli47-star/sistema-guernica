const path = require("path");

// Autoridad unica del calculo de path de la business DB configurada por el proceso. Pura: sin
// sqlite3, sin abrir/crear nada, sin mutar filesystem -- para que backend/db.js, el gate central de
// backend/server.js y scripts/backup-db.js puedan resolver el mismo path ANTES de decidir si es
// seguro abrir cualquier conexion, sin una segunda implementacion paralela de este calculo.
function resolveBusinessDbPath() {
  return process.env.GUERNICA_DB_PATH
    ? path.resolve(process.env.GUERNICA_DB_PATH)
    : path.join(__dirname, "../database/guernica.db");
}

module.exports = { resolveBusinessDbPath };

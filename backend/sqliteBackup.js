// MT-1E2C3A: extraccion pura (sin cambio de comportamiento) de la state machine de SQLite Online
// Backup ya certificada empiricamente en MT-1E2C2B.0/.1/.2 y publicada dentro de
// database/adopt-legacy-baseline.js. Se comparte aqui para que futuros operator tools (p.ej. el
// migrator de MT-1E2C3B) no dupliquen una state machine sensible a condiciones de carrera de
// ~90 lineas. Exporta EXCLUSIVAMENTE crearBackupSQLite -- open/close/cleanup de conexiones sigue
// siendo responsabilidad del caller (adopter, y en el futuro el migrator), igual que antes.
// NO abre ninguna conexion ni toca el filesystem al ser requerido: solo define la funcion.

// init/step/finish explicitos (db.backup(path, cb) SOLO inicializa -- confirmado contra
// node_modules/sqlite3/src/backup.cc). Estados: INITIALIZING -> COPYING -> FINISHING -> SETTLED,
// con un unico finalizador que llama backup.finish() como maximo una vez, sin importar el orden
// de llegada entre el callback de step y el evento 'error' del objeto Backup.
function crearBackupSQLite(sourceReadonlyDb, backupPath, { deadlineMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const ESTADO = { INITIALIZING: "INITIALIZING", COPYING: "COPYING", FINISHING: "FINISHING", SETTLED: "SETTLED" };
    let estado = ESTADO.INITIALIZING;
    let settledOnce = false;
    let retryTimerId = null;
    const startedAt = Date.now();

    const backupObj = sourceReadonlyDb.backup(backupPath, (initErr) => {
      if (initErr) {
        estado = ESTADO.SETTLED;
        if (!settledOnce) { settledOnce = true; reject(initErr); }
        return;
      }
      estado = ESTADO.COPYING;
      intentarStep();
    });

    // Registrado INMEDIATAMENTE (antes de que el init callback dispare): el objeto Backup se
    // construye/retorna sincronicamente, es un EventEmitter valido desde este instante.
    backupObj.on("error", (err) => {
      if (estado === ESTADO.INITIALIZING) return; // el init callback es la autoridad de esa fase
      if (estado === ESTADO.COPYING) { finalizar(err); return; }
      // FINISHING o SETTLED: ya hay un finish en vuelo o completado -- ignorar para el lifecycle.
    });

    function intentarStep() {
      if (estado !== ESTADO.COPYING) return;
      backupObj.step(-1, (stepErr, done) => {
        if (estado !== ESTADO.COPYING) return; // otra via ya movio el estado
        if (stepErr) {
          const retryable = stepErr.code === "SQLITE_BUSY" || stepErr.code === "SQLITE_LOCKED";
          if (retryable && (Date.now() - startedAt) < deadlineMs) {
            retryTimerId = setTimeout(() => {
              retryTimerId = null;
              if (estado !== ESTADO.COPYING) return;
              intentarStep();
            }, 25);
            return;
          }
          finalizar(stepErr);
          return;
        }
        if (!done) { intentarStep(); return; }
        finalizar(null);
      });
    }

    function finalizar(primaryError) {
      if (estado === ESTADO.FINISHING || estado === ESTADO.SETTLED) return;
      estado = ESTADO.FINISHING;
      if (retryTimerId) { clearTimeout(retryTimerId); retryTimerId = null; }
      backupObj.finish((finishErr) => {
        estado = ESTADO.SETTLED;
        if (settledOnce) return;
        settledOnce = true;
        if (primaryError) {
          if (finishErr) primaryError.cleanupDetail = finishErr.message;
          reject(primaryError);
        } else if (finishErr) {
          reject(finishErr);
        } else {
          resolve();
        }
      });
    }
  });
}

module.exports = {
  crearBackupSQLite
};

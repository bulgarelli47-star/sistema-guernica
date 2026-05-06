const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "database", "guernica.db");
const dbPath = process.env.GUERNICA_DB_PATH
  ? path.resolve(process.env.GUERNICA_DB_PATH)
  : DEFAULT_DB;
const backupDir = process.env.GUERNICA_BACKUP_DIR
  ? path.resolve(process.env.GUERNICA_BACKUP_DIR)
  : path.join(ROOT, "backups");
const ifExists = process.argv.includes("--if-exists");
const maxBackups = Number(process.env.GUERNICA_BACKUP_MAX || 30);

function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join("-")
    + "_"
    + [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("-");
}

function pruneBackups() {
  if (!Number.isFinite(maxBackups) || maxBackups <= 0) return;
  const backups = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith("guernica-") && name.endsWith(".db"))
    .map((name) => {
      const fullPath = path.join(backupDir, name);
      return { name, fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const backup of backups.slice(maxBackups)) {
    fs.rmSync(backup.fullPath, { force: true });
  }
}

if (!fs.existsSync(dbPath)) {
  if (ifExists) {
    console.log(`Backup omitido: no existe ${dbPath}`);
    process.exit(0);
  }
  console.error(`No existe la base de datos: ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

const backupPath = path.join(backupDir, `guernica-${timestamp()}.db`);
fs.copyFileSync(dbPath, backupPath);
pruneBackups();

console.log(`Backup creado: ${backupPath}`);

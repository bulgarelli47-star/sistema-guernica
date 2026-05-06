# Base de datos

El servidor usa SQLite.

Por defecto lee:

```powershell
database\guernica.db
```

Para usar otra base sin tocar la principal:

```powershell
$env:GUERNICA_DB_PATH="C:\ruta\a\otra-guernica.db"
npm start
```

Antes de `npm start`, el script `prestart` crea un backup automatico en:

```powershell
backups\
```

Tambien se puede generar manualmente:

```powershell
npm run db:backup
```

Variables utiles:

```powershell
$env:GUERNICA_BACKUP_DIR="D:\Backups\Guernica"
$env:GUERNICA_BACKUP_MAX="50"
```

Nota: las bases `.db`, `.db-wal`, `.db-shm` y la carpeta `backups` estan ignoradas por git. Si una DB ya estaba trackeada de antes, git puede seguir mostrandola modificada hasta que se decida quitarla del indice.

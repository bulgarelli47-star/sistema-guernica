# SISTEMA-GUERNICA — ATLAS OS (multiempresa)

Sistema de gestión comercial / POS **multiempresa (multi-tenant)** sobre Node.js + SQLite: un proceso central que
resuelve, por cada request, a qué empresa (tenant) pertenece y abre la base de negocio correspondiente.

> **Antes de programar, leé [`docs/ESTADO.md`](docs/ESTADO.md).** Es el índice maestro y el estado *verificable* del
> proyecto (qué está implementado, probado, certificado y qué no). Este README es sólo la portada.

## Estructura del repositorio
- `backend/` — servidor HTTP y lógica de negocio/auth/multi-tenant.
- `frontend/` — interfaz de usuario.
- `database/` — esquemas y migraciones (ver `database/README.md`).
- `scripts/` — utilidades y operación.
- `docs/` — documentación (índice: `docs/ESTADO.md`).
- `ecosystem.config.js` — configuración de procesos (PM2).

## Documentación
- **Estado e índice maestro:** [`docs/ESTADO.md`](docs/ESTADO.md)
- **Deploy (legacy, requiere validación operativa antes de producción multiempresa):** [`docs/deploy.md`](docs/deploy.md)
- **Cierres formales:** [`docs/gap-1-closure.md`](docs/gap-1-closure.md) · [`docs/mt-1g-closure.md`](docs/mt-1g-closure.md)

## Reglas de trabajo
- Sin `commit` / `push` / `deploy` sin aprobación del Product Owner.
- No re-ejecutar migraciones ya acreditadas (ver `docs/ESTADO.md` → G-MIG) sin una razón concreta.
- Las afirmaciones de estado deben estar respaldadas por commit, prueba o acta; ver `docs/ESTADO.md`.

**Norte: ATLAS OS multiempresa — PILOTO 1.**

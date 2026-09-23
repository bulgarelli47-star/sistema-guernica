# MT-1G — Cierre formal (certificación cross-tenant end-to-end)

## 1. Identificación del checkpoint y commit base

- **Checkpoint de cierre**: `MT-1G-CLOSE-A1`
- **Commit base (certificado y publicado)**: `e6e41309d859ab6fe769a4a2f649944aa42f6ab7`
- **Parent**: `54694c208370217b52e841fe846ce845427e7626`
- **Rama**: `main`
- **Publicación remota**: `ATLAS-PUSH-729` — verificado contra GitHub (`bulgarelli47-star/sistema-guernica`), no solo contra la caché local de `origin/main`.
- **Checkpoints previos que sustentan este cierre**: `MT-1G-R0`, `MT-1G-R1`, `MT-1G-D1`, `MT-1G-B1`, `MT-1G-R2` (forense de colisión de códigos), `PRODUCT-CODE-D1`/`D2`/`B1`/`B2`/`B2-FIX1`, `ATLAS-CERT-729`, `ATLAS-PRECOMMIT-729`, `ATLAS-COMMIT-729`, `ATLAS-PREPUSH-729`, `ATLAS-PUSH-729`, `MT-1G-CLOSURE-GATE`.

## 2. Alcance contractual de MT-1G

MT-1G es la certificación cross-tenant end-to-end del sistema multi-tenant de Atlas OS. Exige demostrar, como mínimo, siete condiciones de aceptación (G1-G7):

- **G1**: el tenant A no puede leer datos del tenant B.
- **G2**: el tenant A no puede escribir datos del tenant B.
- **G3**: la sesión queda vinculada al tenant correcto (`empresa_id`/`membership_id`/`central_id`).
- **G4**: la autorización está vinculada al membership correcto — un Host de B sin membership autorizado en B falla cerrado.
- **G5**: un usuario central con memberships en A y B puede acceder a ambas empresas.
- **G6**: un tenant inválido o inexistente nunca utiliza una base alternativa ni un fallback inseguro.
- **G7**: las solicitudes concurrentes de A y B mantienen contextos y conexiones de base de datos independientes.

## 3. Matriz G1-G7 con evidencia específica

| Prop. | Test exacto | Código responsable | Comportamiento demostrado | Alcance no cubierto |
|---|---|---|---|---|
| **G1** | `testMT1G1LecturaAutenticadaCrossTenantDenegada` (`scripts/test-stock-flows.js`) | `requireAuth` (`backend/server.js`), `GET /productos` | `GET /productos` con token válido de A contra Host de B: 401 uniforme, sin datos de B, sin mutación en ninguna base | Cobertura directa solo en `/productos` — no extrapolada a otros endpoints |
| **G2** | `testMT1G2EscrituraAutenticadaCrossTenantDenegada` | `requireAuth`, `POST /productos` | `POST /productos` con token de A contra Host de B: rechazada, cero filas nuevas en B, estado de A intacto | Cobertura directa solo en `/productos` — no extrapolada a otros endpoints |
| **G3** | `testMT1F4MultiSesionValidaLigadaATenant`, `testMT1F4MultiSesionCrossTenantFailsClosed` — **regresión MT-1F preexistente** | `requireAuth` (verificación `empresa_id`/`membership_id`/`central_id`) | Sesión válida solo cuando coincide exactamente con el tenant resuelto por Host; una fila de sesión inyectada con `empresa_id` de B sigue rechazada si el `membership_id` no corresponde | No cubre cada endpoint protegido individualmente |
| **G4** | `testMT1F4MultiLoginMembershipOtroTenantNoAutoriza`, `testMT1F4MultiMembershipYEmpresaRevocanSesion` — **regresión MT-1F preexistente** | `requireAuth` + revocación por `usuario_empresas`/`empresas.activa` | Login contra Host de B sin membership en B: rechazado, cero sesiones en B; revocar la membership de A invalida su sesión de inmediato | No cubre cambios de membership en tiempo real durante una request ya en curso |
| **G5** | `testMT1G5UsuarioDualMembershipResuelveEmpresas` | Helper `mt1gCrearUsuarioDualMembership` + `requireAuth` | Un único usuario central con membership real en A y en B: login independiente en cada Host resuelve el tenant correcto; el token de A no autoriza en B ni viceversa | Ver sección 4 — Alcance A, no B |
| **G6** | `testMT1F3NoFallbackAGuernicaEnMulti`, `testMT1F3TenantDesconocidoFailsClosed` — **regresión MT-1F preexistente** | `validarTenantAntesDeAbrirDb`, `crearTenantRequestMiddleware` (`backend/tenantRequestMiddleware.js`) | Host inválido/inexistente falla cerrado; instrumentación real de aperturas SQLite confirma que `database/guernica.db` nunca se abre, ni en éxito ni en fallo | No re-auditada en checkpoints posteriores a su certificación original |
| **G7** | `testMT1G7ConcurrenteAutenticadoAislado` | `requireAuth` + `/productos` + contexto ALS (`backend/tenantRequestContext.js`) | 20 operaciones autenticadas concurrentes reales (`Promise.all`) entre A y B: aislamiento de lectura y escritura mantenido, 5+5 escrituras persistidas sin cruce | No cubre concurrencia con más de 2 tenants simultáneos |

**Nota**: G3, G4 y G6 se apoyan explícitamente en pruebas de la batería MT-1F, preexistentes a MT-1G — no se presentan como cobertura nueva de este cierre.

## 4. Decisión expresa del Product Owner sobre G5

Juan (Product Owner) aprobó expresamente:

> **G5 = ALCANCE A.** Un usuario central puede tener membresías en varias empresas y acceder a cada una mediante una autenticación independiente. NO se exige cambiar de empresa dentro de una misma sesión como condición para cerrar MT-1G.

**Contrato cerrado bajo Alcance A**:
- Un usuario central puede tener acceso legítimo a múltiples empresas.
- Cada empresa mantiene su propia sesión, vinculada a su `empresa_id` y `membership_id`.
- Una sesión de A **no** autoriza operaciones en B.
- Para ingresar a B se requiere autenticación independiente y verificación de su membership.

La implementación actual satisface este contrato y fue certificada mediante `testMT1G5UsuarioDualMembershipResuelveEmpresas`.

**Distinción explícita**:
- **CONTRATO CERRADO**: acceso multiempresa mediante autenticaciones independientes (ya implementado, certificado y publicado).
- **MEJORA FUTURA** (no incluida en este cierre): interfaz para seleccionar otro comercio y solicitar una nueva autenticación sin re-tipear credenciales completas — ver sección 7.

Estas dos funcionalidades **no deben confundirse**: la primera está cerrada; la segunda es una reserva arquitectónica para una etapa posterior.

## 5. Certificación ATLAS-CERT-729

```
START = 729
PASS  = 729
FAIL  = 0
Marcador "OK stock, ventas, caja y permisos basicos" = 1
stderr = 0 bytes
exit code = 0
```

Corrida única, sin filtros, sobre el candidate identificado por:
```
backend/server.js            97f95788aeff1d82ce1850f29cc47b42a949561df0267c5ceede1a58e8455ec4
scripts/test-stock-flows.js  e6afba3a08436e72868edae9a90e1896e8b746ecef1b9f50d344d1fe0ab9e0fe
```
Publicado en GitHub mediante `ATLAS-PUSH-729`, verificado directamente contra el HEAD real remoto (`git ls-remote`), no solo contra la caché local.

## 6. Limitaciones de cobertura conocidas

- G1/G2 tienen cobertura directa únicamente sobre `POST`/`GET /productos` — no se extrapola a cada endpoint de negocio del sistema.
- G6 no fue re-auditada en los checkpoints posteriores a su certificación original dentro de la batería F3.
- G7 cubre exactamente 2 tenants concurrentes, no un número mayor.
- El mecanismo de reintento de código automático de producto (`generarCodigoProducto`) tiene un límite de 5 intentos — no garantiza éxito bajo cualquier carga de concurrencia extrema (documentado en `PRODUCT-CODE-D1`/`R2`).
- G5 queda cerrado exclusivamente bajo Alcance A — ver sección 4.

## 7. Reserva futura — Visión global multiempresa

**Esta sección es una reserva arquitectónica. No se ha diseñado ni implementado nada de lo descrito aquí.**

### A. Visión por empresa
Dashboard operativo del comercio activo: ventas, caja, stock y demás módulos según los permisos correspondientes.
**Ícono reservado**: Lucide `store`.

### B. Visión global
Dashboard con indicadores consolidados y comparativas entre los comercios a los que el usuario esté autorizado a acceder.
**Ícono reservado**: Lucide `layout-dashboard`.

### C. Cambio de comercio
Interfaz futura que permitirá seleccionar un comercio diferente y solicitar una nueva autenticación. No expondrá tokens internos al usuario.
**Ícono reservado**: Lucide `lock-keyhole`.

### D. Frontera de seguridad
La visión global deberá contar con un contrato de autorización propio. No podrá utilizar una sesión operativa de un comercio para obtener acceso indiscriminado a los demás. Las consultas consolidadas deberán respetar los permisos y las memberships vigentes en cada empresa. No se compartirán ni mezclarán conexiones de bases de datos entre tenants.

### E. Momento de diseño
Antes de congelar formalmente la **MULTI-TENANT FOUNDATION**, se deberá revisar que la arquitectura permita incorporar posteriormente una visión global autorizada, sin romper el aislamiento ya certificado por MT-1G.

Esto es una reserva arquitectónica, **no un requisito para cerrar MT-1G**. Explícitamente fuera de alcance en este documento y en este cierre: endpoints del dashboard, consultas SQL de agregación, nuevas tablas, nuevos roles, pantallas, componentes de frontend, KPIs y sus fórmulas.

## 8. Estado de cierre de MT-1G

# MT-1G — CLOSED

Cierre técnico y funcional bajo el alcance expresamente aprobado por el Product Owner (G5 = Alcance A). Documento creado localmente. Commit y publicación documental de este archivo pendientes de un checkpoint separado.

## 9. Relación con el siguiente gate del roadmap

```
MT-1F
  ↓
MT-1G — CLOSED (este documento)
  ↓
GAP-1 CLOSED          ← NO declarado en este documento
  ↓
MULTI-TENANT FOUNDATION CLOSED   ← NO declarado en este documento
  ↓
TX-1
  ↓
Integraciones posteriores
```

El cierre de **GAP-1** y de **MULTI-TENANT FOUNDATION** requieren su propio gate formal, análogo a este, y no quedan declarados por este documento.

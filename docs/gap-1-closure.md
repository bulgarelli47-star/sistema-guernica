# GAP-1 — Cierre formal (routing multi-tenant dinámico)

## 1. Identificación de GAP-1

GAP-1 nombra el problema de enrutamiento dinámico multi-tenant: permitir que un único proceso Node atienda múltiples empresas, resolviendo por cada request cuál base de negocio corresponde, en vez del modelo legacy de una base fija por proceso.

## 2. Commit base y certificación

- **Commit base (HEAD al momento de este cierre)**: `5bfbd6d5b2ba51481f4d858cf65369ea73e9c093`
- **Certificación integral vigente**: `ATLAS-CERT-729` — `START=729, PASS=729, FAIL=0`, marcador único, `stderr=0 bytes`, `exit=0`.
- **Checkpoint de recuperación de evidencia**: `GAP-1-EVIDENCE-GATE`.

## 3. Distinción entre contrato histórico explícito y contrato reconstruido

### A. Evidencia histórica explícita
Únicamente dos piezas del código citan "GAP-1" literalmente en su comentario original, como "Slice" del problema:

- **MT-1E1** (commit `b0550a5`, *"feat(multitenant): agrega contexto de tenant por host"*) — `backend/tenantHostContext.js:5`: *"GAP-1 Slice 1 (MT-1E1): parser puro Host → contexto candidato de tenant."*
- **MT-1E2B** (commit `8d457b1`, *"feat(multitenant): agrega verificador de version de schema"*) — `backend/businessSchemaVersion.js:1`: *"GAP-1 (MT-1E2B): catálogo de migraciones + clasificador puro + verificador READONLY de estado."*

Ningún otro artefacto del repositorio, del historial de commits (`git log --all`, mensajes completos) ni de la evidencia externa conservada bajo `C:\AtlasDiagnostics\` menciona "GAP-1" como etiqueta explícita de ningún otro módulo, ni contiene un acta o declaración de cierre previa.

### B. Evidencia de implementación posterior
Las siguientes piezas **no se etiquetan "GAP-1" en su propio comentario**, pero completan materialmente el mismo problema (enrutamiento dinámico seguro) y dependen directamente de MT-1E1/E2B:

- **MT-1E7B** (commit `d6ddb8f`, *"refactor(multitenant): convierte runtime a verify-only"*) — Runtime Verify-Only Boot Gate (`validarTenantAntesDeAbrirDb`, `backend/server.js:328-396`), consume `verificarBusinessSchemaVersion` de MT-1E2B.
- **MT-1F1** (commit `164e484`, *"feat(multitenant): agrega runtime tenant handle registry"*) — registro/handle de tenant en runtime.
- **MT-1F2** (commit `a8858d7`, *"feat(multitenant): agrega contexto async de tenant"*) — contexto `AsyncLocalStorage` por request.
- **MT-1F3** (commit `8156a80`, *"feat(multitenant): enruta contexto tenant por request"*) — enrutamiento real, gate `ATLAS_TENANCY_MODE=multi`.

### C. Límite documental
**No se recuperó ninguna acta histórica independiente que declare GAP-1 CLOSED**, ni en el repositorio ni en la evidencia externa conservada. No se afirma ni se infiere una fecha histórica de cierre. **Este documento es la formalización actual del cierre**, bajo el contrato reconstruido de la sección 4, no la confirmación de un cierre que ya existiera antes.

## 4. Alcance adoptado para este cierre (contrato reconstruido)

El Product Owner adopta, para este cierre, el siguiente contrato — **reconstruido desde el código y las pruebas actuales, no citado de ningún documento original**:

> GAP-1 permite que un único proceso Node atienda múltiples empresas mediante enrutamiento dinámico por request. Cada request debe: interpretar correctamente el Host; resolver la empresa correspondiente; verificar que el tenant es válido; seleccionar su base de negocio; establecer el contexto ALS correcto; mantener aisladas las bases de empresas; fallar cerrado ante errores o tenants desconocidos, sin fallback a Guernica. El arranque debe respetar los verificadores de identidad y versión del esquema existentes, sin ejecutar migraciones automáticas. El modo single debe conservar su contrato de compatibilidad previamente certificado.

## 5. Matriz técnica MT-1E / MT-1F

| Módulo | Commit | Archivo principal | Función técnica | Evidencia GAP-1 |
|---|---|---|---|---|
| MT-1E1 | `b0550a5` | `backend/tenantHostContext.js` | Parser puro de Host → contexto candidato | **Explícita** (comentario original) |
| MT-1E2B | `8d457b1` | `backend/businessSchemaVersion.js` | Catálogo de migraciones + clasificador + verificador READONLY | **Explícita** (comentario original) |
| MT-1E7B | `d6ddb8f` | `backend/server.js` (`validarTenantAntesDeAbrirDb`) | Runtime Verify-Only Boot Gate, ambos modos | Posterior — completa el boot gate que MT-1E1/E2B dejaban pendiente |
| MT-1F1 | `164e484` | `backend/runtimeTenantRegistry.js` | Registro/handle de tenant, cacheado, single-flight | Posterior — resolución dinámica concreta |
| MT-1F2 | `a8858d7` | `backend/tenantRequestContext.js` | Contexto ALS por request + `db.js` consciente de contexto | Posterior — "un proceso, N tenants" concretado |
| MT-1F3 | `8156a80` | `backend/tenantRequestMiddleware.js` | Enrutamiento real, gate `ATLAS_TENANCY_MODE=multi` | Posterior — el "slice de autorización real" que MT-1E1 anticipaba |

## 6. Inventario de las 78 pruebas relevantes

**Subtotal MT-1E (32 PASS)** — módulos con etiqueta GAP-1 explícita o su boot gate directo, **fuera de las 122 regresiones MT-1F**:

- **MT-1E1 (8)**: `testMT1E1AHostTenantNormal`, `testMT1E1AHostTenantUppercaseConPuerto`, `testMT1E1AHostApexReservado`, `testMT1E1AHostSubdominiosReservados`, `testMT1E1AHostMultiNivelInvalido`, `testMT1E1AHostLocalDevValido`, `testMT1E1AHostMalformadoRechazado`, `testMT1E1ALegacySinCambioPorHostParser`
- **MT-1E2B (10)**: `testMT1E2BSchemaClassifierCurrent`, `testMT1E2BSchemaClassifierBehind`, `testMT1E2BSchemaClassifierAhead`, `testMT1E2BSchemaClassifierInvalidHistory`, `testMT1E2BSchemaVerifierUnversioned`, `testMT1E2BSchemaVerifierCurrent`, `testMT1E2BSchemaVerifierInvalidTable`, `testMT1E2BSchemaVerifierDbFailures`, `testMT1E2BSchemaVerifierRequiereDbPathExplicito`, `testMT1E2BSchemaVersionModuleSinSideEffects`
- **MT-1E7B (14)**: `testMT1E7BCurrentTenantBootsSinSchemaMutation`, `testMT1E7BCurrentTenantBootsSinBusinessRepair`, `testMT1E7BCajaRequestNoEnsureSchema`, `testMT1E7BOtroModuloRequestNoEnsureSchema`, `testMT1E7BMissingRequiredTableFailsClosed`, `testMT1E7BMissingRequiredColumnFailsClosed`, `testMT1E7BUnversionedFailsClosedNoAdopt`, `testMT1E7BIdentityMissingCentralFailsNoProvision`, `testMT1E7BIdentityMismatchCentralFailsClosed`, `testMT1E7BLegacyModeRequiresBaselineYCurrent`, `testMT1E7BMissingDbNoOpenCreateFallback`, `testMT1E7BBusinessWritesNormalesFuncionan`, `testMT1E7BCurrentBootPersistentSnapshotSinMutacion`, `testMT1E7BReadOnlyRequestNoSchemaMutation`

**Subtotal MT-1F (46 PASS)** — evidencia posterior del contrato reconstruido, **incluidas dentro de las 122 regresiones MT-1F ya certificadas**:

- **MT-1F1 (16)**: `testMT1F1HandleCurrentValido`, `testMT1F1HandleUsaOpenReadwriteSinCreate`, `testMT1F1MissingDbNoCreaArchivo`, `testMT1F1IdentityMismatchFailsClosed`, `testMT1F1BaselineInvalidoFailsClosed`, `testMT1F1SchemaUnversionedFailsClosed`, `testMT1F1SchemaNoCurrentFailsClosed`, `testMT1F1HandleInmutable`, `testMT1F1MismoTenantCacheaMismoHandle`, `testMT1F1MismoTenantConcurrenteSingleFlight`, `testMT1F1FalloConcurrenteNoQuedaCacheado`, `testMT1F1TenantAErrorNoAfectaTenantB`, `testMT1F1TenantsDistintosHandlesDistintos`, `testMT1F1PathDuplicadoEntreEmpresasFailsClosed`, `testMT1F1CerrarTenantNoCierraOtro`, `testMT1F1CerrarTodosPermiteReabrir`
- **MT-1F2 (14)**: `testMT1F2ContextoAusentePorDefecto`, `testMT1F2HandleInvalidoNoEntraContexto`, `testMT1F2ContextoPropagaAwaitYTimers`, `testMT1F2ContextosConcurrentesAislados`, `testMT1F2ContextoAnidadoRestauraAnterior`, `testMT1F2DbGetDbUsaHandleActivo`, `testMT1F2DbSinContextoConservaSingleton`, `testMT1F2DbContextoNoFallbackASingleton`, `testMT1F2CloseDbNoCierraHandleTenant`, `testMT1F2HelpersDesestructuradosResuelvenEnEjecucion`, `testMT1F2SqlLecturaEsAisladaAB`, `testMT1F2SqlEscrituraConcurrenteEsAisladaAB`, `testMT1F2TransaccionANoInterfiereConB`, `testMT1F2ErrorLimpiaContextoSinAfectarOtro`
- **MT-1F3 (16)**: `testMT1F3SingleLegacyNoActivaRouting`, `testMT1F3SingleCentralNoActivaRouting`, `testMT1F3MultiTenantHostResuelveHandle`, `testMT1F3MultiRequestEntraContextoALS`, `testMT1F3MultiHelpersUsanDbDelHost`, `testMT1F3ConcurrenteRequestARequestBAisladas`, `testMT1F3TenantDesconocidoFailsClosed`, `testMT1F3TenantInactivoFailsClosed`, `testMT1F3TenantDbInvalidaFailsClosed`, `testMT1F3FallosTenantNoEnumerables`, `testMT1F3LocalFailsClosedEnMulti`, `testMT1F3ReservedFailsClosedEnMulti`, `testMT1F3InvalidFailsClosedEnMulti`, `testMT1F3ApexFailsClosedEnRutaTenant`, `testMT1F3NoFallbackAGuernicaEnMulti`, `testMT1F3ErrorRequestLimpiaContexto`

**TOTAL: 78/78 PASS**, todos parte de `ATLAS-CERT-729` (`START=729, PASS=729, FAIL=0`, marcador único, `stderr=0 bytes`, `exit=0`). Nombres verificados contra `C:\AtlasDiagnostics\ATLAS-CERT-729\stdout.log`, sin ejecutar ninguna prueba en este checkpoint.

## 7. Propiedades de seguridad demostradas

- El Host se interpreta exclusivamente desde `req.headers.host` (nunca `X-Forwarded-*` sin validar).
- Un Host desconocido, inactivo o con identidad de base inválida falla cerrado — `testMT1F3TenantDesconocidoFailsClosed`, `...TenantInactivoFailsClosed`, `...TenantDbInvalidaFailsClosed`.
- **`database/guernica.db` real nunca se abre en modo multi**, ni en éxito ni en fallo — demostrado con instrumentación real de aperturas SQLite en `testMT1F3NoFallbackAGuernicaEnMulti`.
- Las bases se abren con `OPEN_READWRITE` sin `OPEN_CREATE` — `testMT1F1HandleUsaOpenReadwriteSinCreate`.
- El contexto ALS aísla lecturas y escrituras concurrentes entre tenants — `testMT1F2SqlLecturaEsAisladaAB`, `...SqlEscrituraConcurrenteEsAisladaAB`, `testMT1F3ConcurrenteRequestARequestBAisladas`.
- El boot gate nunca migra ni repara el esquema en ninguno de los dos modos — 14 tests `testMT1E7B...`.
- El modo single conserva su comportamiento exacto — `testMT1F3SingleLegacyNoActivaRouting`, `...SingleCentralNoActivaRouting`.

## 8. Límites de cobertura

**No se atribuye a MT-1F3 la autorización completa por membership** — esa propiedad corresponde a MT-1F4 (autenticación central y membership), un slice distinto y posterior, fuera del alcance de este cierre. **No se atribuyen a GAP-1 las 122 regresiones MT-1F completas** — únicamente las 46 de F1/F2/F3 (routing dinámico); F4 (membership), F5A (cola de stock), F5B (uploads) y F5C (credenciales) certifican propiedades operativas posteriores, ajenas al contrato de GAP-1. No se declara cobertura universal de endpoints de negocio — esa certificación específica corresponde a G1/G2 de MT-1G.

## 9. Deudas expresamente diferidas

| Deuda | Estado histórico recibido | Verificación en el código actual | Relación con GAP-1 |
|---|---|---|---|
| **TX-SAME-TENANT** | OPEN | **Confirmada**: comentarios explícitos "OPEN" en `scripts/test-stock-flows.js:33443,35831` | Fuera del alcance de GAP-1 — es concurrencia *dentro* del mismo tenant, no aislamiento *entre* tenants. Pendiente para TX-1 |
| **BRIDGE-DUAL-WRITE** | OPEN/NON-BLOCKING (antecedente histórico) | Sin verificación documental actual en el repositorio consultado | No se declara resuelta por ausencia de menciones |
| **OPS-MULTI-PRESTART** | OPEN (antecedente histórico) | Sin verificación documental actual en el repositorio consultado | Requiere auditoría de scripts operativos (incluido backup) antes de cualquier despliegue multi — no se resuelve aquí |
| **PRIVATE-MEDIA-HARDENING** | DEFERRED (antecedente histórico) | Sin verificación documental actual en el repositorio consultado | La separación física de uploads (F5B) no equivale a certificar privacidad completa de medios |

Ninguna de estas deudas se convierte en requisito retroactivo del contrato de GAP-1 aquí adoptado.

## 10. Relación con MT-1G CLOSED

MT-1G (`docs/mt-1g-closure.md`, commit `5bfbd6d`) certifica garantías end-to-end de acceso autenticado y aislamiento cross-tenant (G1-G7), construidas **sobre** la maquinaria de enrutamiento que GAP-1 provee. GAP-1 es la capa de *routing*; MT-1G es la capa de *autorización y aislamiento end-to-end* que depende de ese routing. Ambos cierres son complementarios, no redundantes.

## 11. Relación con la reserva de visión global

Sin cambios ni decisiones nuevas respecto a `docs/mt-1g-closure.md` sección 7: íconos reservados `store`, `layout-dashboard`, `lock-keyhole`; la futura visión global deberá contar con autorización propia, respetar membresías vigentes, y nunca reutilizar una sesión operativa de un tenant para acceder indiscriminadamente a otros. No se diseñó ni desarrolló nada del dashboard en este checkpoint.

## 12. Estado de cierre

# GAP-1 — CLOSED

Cierre técnico y documental bajo el alcance reconstruido adoptado en la sección 4. Acta creada localmente. Commit y publicación pendientes de checkpoints separados.

**No se declara**: MULTI-TENANT FOUNDATION CLOSED, TX-1 completado, ni producción multiempresa habilitada.

## 13. Próximo gate de Foundation

Con GAP-1 y MT-1G ambos documentados como cerrados, el siguiente paso natural del roadmap es un gate formal de **MULTI-TENANT FOUNDATION CLOSED**, que deberá reconciliar las deudas de la sección 9 (particularmente confirmar el estado real de BRIDGE-DUAL-WRITE, OPS-MULTI-PRESTART y PRIVATE-MEDIA-HARDENING con el Product Owner) antes de poder declararse.

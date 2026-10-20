# ATLAS OS — ESTADO DEL PROYECTO (índice maestro verificable)

**Referencia:** rama `main`, commit `f2a9bf3d218296114c092c9c86d8a40fc40f0ae6` (abreviado `f2a9bf3`). Consolidación
documental del **2026-10-20**. Este documento es la **única fuente de estado** del repositorio; los cierres por trabajo
viven en `docs/gap-1-closure.md` y `docs/mt-1g-closure.md` (enlazados abajo). Todo lo aquí afirmado está etiquetado por
su **nivel de verificación** (ver §0).

## 0. Cómo leer este documento — niveles de estado y de verificación

Estados de un trabajo (no son equivalentes entre sí):
- **IMPLEMENTADO** — el código está en `main`.
- **PROBADO** — existe evidencia de pruebas (harness, fast-forward, smoke) asociada.
- **CERTIFICADO** — existe una aceptación/certificación **con alcance declarado** (y ese alcance es acotado, no global).
- **PRESENTE EN RUNTIME** — se verificó el *checkout*, la versión/commit y/o el esquema del runtime; **no** implica que el
  servicio HTTP/PM2 esté activo ni que los endpoints respondan.
- **OPERATIVO VERIFICADO** — reservado para **evidencia real de ejecución y funcionamiento del servicio** (servicio
  levantado, endpoints respondiendo). **En esta consolidación NINGÚN trabajo alcanza este nivel**: no se ejecutó el servicio.

Reglas de precisión aplicadas en todo el documento:
- **Un merge no es una certificación funcional.** Las ramas `feat/*` están merged a `main`; eso prueba integración de
  código, no corrección funcional end-to-end.
- **Código en el runtime ≠ servicio operativo.** Se verificó el *checkout* y el *esquema*, no el servicio en ejecución.
- **Aislamiento probado en ciertos endpoints ≠ todos los endpoints certificados.**
- **Una migración histórica aprobada no se repite** sin una razón concreta.
- **La ausencia de una evidencia localizada no demuestra que el trabajo no se hizo.**
- No se declara **Foundation completa** ni **PILOTO 1 READY** por inferencia.

Nivel de verificación de cada dato: **[V]** verificado READ-ONLY en esta consolidación · **[C]** citado de un documento
de cierre existente (no re-ejecutado aquí) · **[N/L]** referencia no disponible localmente.

## 1. Arquitectura funcional y multiempresa
POS / gestión comercial sobre **Node.js + SQLite**. Modelo **multi-tenant**: un proceso central resuelve, **por request**,
el tenant (por host/contexto) y abre la base de negocio correspondiente, en lugar del modelo legacy de una base fija por
proceso. Hay una **autoridad central** (usuarios/roles/estado/membership) proyectada hacia cada tenant, y aislamiento por
tenant en acceso, colas de stock y uploads. **[V]** (serie de commits `feat(multitenant):`, ver §2).

## 2. Componentes implementados (archivos / commits) — **IMPLEMENTADO [V]**
Fuente: `git log`/`git branch --merged main` (verificado). Rutas relativas al repo.
- **Contexto y ruteo multi-tenant:** `feat(multitenant)` `b0550a5` (contexto por host), `8156a80` (ruteo por request),
  `a8858d7` (async context), `164e484` (runtime handle registry) — en `backend/`.
- **Identidad/provisioning de tenant y baseline:** `ed98e1f`, `98576bb`, `428442f`, `d6ddb8f`, `899decc`, `8d457b1`.
- **Bridge legacy / migrador de tenant:** `32336fc`, `a484678`, `cb2d67b`, `443da46`.
- **Autorización por membership + aislamiento:** `8a17903` (authz por membership), `2fb592a` (cola de stock por tenant),
  `0205765` (uploads por tenant).
- **Autoridad central (auth):** serie `feat(auth)` (`9e6ebed`, `43d4b97`, `2ea14c7`, `1c5053a`, `80ddef1`, `50082be`,
  `6d62658`, `8faf68f`, `78d0f5a`) — esquema de sincronización central, proyección rol/estado, outbox/recovery, UI central.
- **Integración de credenciales / Mercado Pago (INT-1):** `f1524ad`, `e6131cf`, `54694c2` (aísla credenciales por tenant).
- **Seguridad:** `f2a9bf3` (encode de texto público en dashboard), rama `fix/sec-xss-1-public-orders` (merged).

> **Nota de alcance:** este listado prueba **IMPLEMENTADO**; la corrección funcional end-to-end sólo está **CERTIFICADA**
> para los alcances declarados en §4 (GAP-1, MT-1G). El resto está PROBADO vía aceptaciones de checkpoint, no certificado
> como cobertura global.

## 3. IMPLEMENTADO vs PROBADO vs CERTIFICADO vs PRESENTE EN RUNTIME (síntesis)
| Trabajo | Commit / rama | IMPL | PROB | CERT (alcance) | PRESENTE EN RUNTIME | Verif. |
|---|---|---|---|---|---|---|
| Foundation multiempresa | serie `feat(multitenant)` | ✓ | ✓ | parcial → vía GAP-1 + MT-1G | sí (checkout+esquema) | [V] impl/[C] cert |
| **GAP-1** (routing dinámico) | base `5bfbd6d` / `fc53924` docs | ✓ | ✓ | **ATLAS-CERT-729 (729/729)** — routing multi-tenant | sí (checkout+esquema) | [C] |
| **MT-1G** (cross-tenant E2E) | `e6e4130` / `ATLAS-PUSH-729` | ✓ | ✓ | **cross-tenant G1–G7** (alcance de los 7 criterios) | sí (checkout+esquema) | [C] |
| **INT-1** (credenciales/MP) | `f1524ad`,`e6131cf`,`54694c2` | ✓ | ✓ (PILOT-INT-1 FF=0) | no dedicada | sí (checkout) | [V] |
| **BACKUP-1** (snapshot/restore) | `d9526dc`,`32a655d` / `feat/backup1-atlas-snapshot` | ✓ | ✓ (FF=0) | no dedicada | sí (checkout) | [V] |
| **WORKER-OPS-1** (outbox/PM2) | `bd76600` / `feat/worker-ops-1` | ✓ | ✓ (FF=0) | no dedicada | sí (checkout) | [V] |
| **ONBOARD-1** (alta tenant) | `4c45765` / `feat/onboard-1` | ✓ | ✓ (smoke+FF) | no dedicada | sí (checkout) | [V] |
| **TX-1 A/B** (write coordinator) | `68e2337`,`6d63d65`,`a0c143e`,`9e87f78` / `feat/tx1a*`,`tx1b*` | ✓ | ✓ (harness) | no dedicada | sí (checkout) | [V] |

«PRESENTE EN RUNTIME» = el código está en el checkout del runtime (`f2a9bf3`, esquema `@004`); **ningún trabajo alcanza
OPERATIVO VERIFICADO** (no se verificó el servicio en ejecución). «FF=0» = chequeo fast-forward con `FF_EXIT=0` en el
archivo local de evidencias (checkpoints `PILOT-INT-1`, `BACKUP-1B`, `WORKER-OPS-1B`, `ONBOARD-1B`). «no dedicada» = sin
acta de certificación propia; respaldo = merge + evidencia de checkpoint (recordar: **merge ≠ certificación funcional**).

## 4. Pruebas y certificaciones — alcance exacto
- **ATLAS-CERT-729** **[C]**: certificación integral citada en `docs/gap-1-closure.md` (`START=729, PASS=729, FAIL=0`,
  `stderr=0`, `exit=0`). **No re-ejecutada** en esta consolidación. Sustenta GAP-1.
- **MT-1G / ATLAS-PUSH-729** **[C]**: certificación cross-tenant end-to-end con 7 criterios G1–G7 (`docs/mt-1g-closure.md`),
  base `e6e4130`, publicada y verificada contra GitHub. Alcance = los 7 criterios declarados, **no** todos los endpoints.
- **Checkpoints funcionales** **[V]**: `PILOT-INT-1`, `BACKUP-1/1B`, `WORKER-OPS-1/1B`, `ONBOARD-1/1B`, `TX-1A/1B` tienen
  evidencia de prueba (FF, smoke, git-preflight) en el archivo local de evidencias. Prueban integración/no-regresión; no
  son certificaciones de cobertura global.

## 5. G-MIG-DRY y G-MIG real — aceptaciones históricas
- **G-MIG-DRY** **[V]**: ensayo de migración con inventario pre/post y comparación de datos (evidencia 01–15 en el
  checkpoint `G-MIG-DRY`). Estado: **CLOSED (ensayo)**.
- **G-MIG real (002→004)** **[V (lectura de actas)]**: migración del esquema de negocio a `004` sobre el runtime real.
  Aceptaciones independientes READ-ONLY: **`G-MIG-REAL-CP-F` → PASS** (migración 002→004, esquema y timestamps 001/002
  preservados, sólo columnas nuevas NULL) y **`G-MIG-REAL-CP-H3-FINAL` → PASS FORMAL** (respaldo externo POST-migración en
  Backblaze B2). Estado: **CLOSED / acreditada**. **No repetir** sin razón concreta (regla de precisión).

## 6. Certificación de aislamiento R2 (instrumental) y ACCEPT-6C
El carril `MT-FUNC-3D-0B-R2-CERT-TOOLING-*` construyó y auditó un **instrumental de diagnóstico** para certificar el
aislamiento multi-tenant sobre el laboratorio R2 (bases CONTROL/A/B sintéticas). Resumen **[V]** (evidencia propia de esta
serie):
- **FIX-6C** (instrumental corregido): manifiesto `67ee26b8…`, 41 entradas; DEV 73/73; aceptación interna PASS.
- **ACCEPT-6C** (auditoría adversarial independiente de FIX-6C): manifiesto `360830d4…`. Resultado: **favorable
  TÉCNICAMENTE** (las cinco hipótesis H1/P3/P1/P2/comercial se validaron contra el código real en un clon byte-idéntico),
  **pero K (procedimiento) = NO_CONFORME**: la auditoría continuó tras dos verdictos `DEFICIENTE` que eran **falsos
  negativos del propio instrumento auditor** (regex estáticos), corregidos en corrida (`03b`, `05b`) en lugar de detener y
  rehacer limpio. **Este resultado histórico NO se reescribe**: ACCEPT-6C queda registrado como *favorable técnico con no
  conformidad procedimental*. Un `ACCEPTED` formal requiere un waiver expreso del PO **o** una re-auditoría limpia.
- **Importante:** esto certifica (con la salvedad anterior) el **instrumental**, no el producto. El **aislamiento de los
  endpoints reales sobre datos R2 no está certificado** (ver §7).

## 7. R2-CERT-2 — **PENDIENTE DE EJECUCIÓN**
Aplicar el instrumental al laboratorio R2 **real** (CONTROL/A/B) bajo disciplina baseline+hash+restore, READ-mostly, para
acreditar sobre datos reales: aislamiento CONTROL/A/B, Bearer por tenant, write-set, historial y ejecutor cerrado (2
logins + 6 ops, 9ª prohibida). **No ejecutado.** Requiere orden explícita del PO.

## 8. Pendientes y deudas acreditadas
- **R2-CERT-2** (§7): pendiente. **[V]**
- **Estado formal de ACCEPT-6C** (§6): requiere decisión del PO (waiver o ACCEPT-6D). **[V]**
- **Defensa en profundidad P2** (no bloqueante): la compuerta de acceptance del finalizador del instrumental confía en el
  invariante del productor (`battery.js`: `passed ⇔ allRan`) y no re-verifica el conteo de forma redundante. Endurecimiento
  opcional, no bloqueante. **[V]**
- **Deploy legacy sin validar** (§11): `docs/deploy.md` describe procedimientos **legacy**; requieren **validación
  operativa** antes de habilitar **producción multiempresa**. No validados aquí. **[V]**
- **Documentación**: sólo `deploy.md` + los dos cierres existen en el repo; este `ESTADO.md` y el `README.md` son la
  consolidación propuesta. **[V]**

*No se declaran otras deudas por ausencia de documentación*: donde no hallé un acta dedicada (INT-1, BACKUP-1,
WORKER-OPS-1, ONBOARD-1, TX-1), el trabajo está respaldado por merge + evidencia de checkpoint, por lo que **no** se cuenta
como pendiente.

## 9. Dependencias y condiciones para PILOTO 1

**Distinción de alcance (no dar por aprobado un cambio de alcance):**
- **Piloto inicial de una empresa** — poner en marcha operativa a **un** tenant real. Es un posible primer paso práctico.
- **Objetivo de validación multiempresa** — el objetivo real del proyecto: **certificar el aislamiento CONTROL/A/B** y
  **operar dos empresas** simultáneamente sin fuga entre tenants.

Un piloto inicial de una sola empresa **no sustituye ni reduce** el objetivo multiempresa. La certificación de aislamiento
CONTROL/A/B y la operación de dos empresas **siguen siendo objetivos necesarios**; este documento **no** da por aprobado
reducir el alcance a una sola empresa.

**Condiciones necesarias (ninguna cumplida aún):**
1. Resolver el estado formal del instrumental (§6): waiver del PO sobre ACCEPT-6C **o** ACCEPT-6D limpio.
2. **R2-CERT-2** ACCEPTED (§7): certificación del **aislamiento CONTROL/A/B** sobre datos reales (objetivo multiempresa).
3. Criterios de aptitud operativa por tenant (alta producto/cliente, movimiento de stock, login, cambio de rol/estado) y
   **prueba de no-fuga entre tenants** con **dos empresas** operando.
4. Validación operativa del deploy (§4 nota / `docs/deploy.md` es legacy — ver §11) y Go/No-Go con rollback por restore
   (capacidad de BACKUP-1).

**No se declara PILOTO 1 READY ni Foundation completa por inferencia**: faltan (1)–(4). La base multiempresa está
IMPLEMENTADA y PRESENTE EN RUNTIME, pero la aptitud del piloto depende de la certificación de aislamiento sobre datos
reales y de la operación de dos empresas, aún pendientes.

## 10. Mapa Maestro ATLAS OS V1.1 — referencia externa
El "Mapa Maestro ATLAS OS V1.1" **existe como documento externo del proyecto** (autoridad citada), pero **no estuvo
disponible en el entorno local de esta consolidación** (no se encontró en `docs/` ni como `.md` en el árbol local).
**[N/L]** — por lo tanto **su contenido NO fue reconciliado ni verificado aquí**; no se afirma concordancia ni
discrepancia con él. Lo verificado en este documento proviene exclusivamente de: historial Git, `docs/` existente y el
archivo local de evidencias (checkpoints). La reconciliación con el Mapa Maestro queda **pendiente** para cuando el
documento esté disponible localmente.

## 11. Enlaces
- [`docs/gap-1-closure.md`](gap-1-closure.md) — cierre formal GAP-1.
- [`docs/mt-1g-closure.md`](mt-1g-closure.md) — cierre formal MT-1G.
- [`docs/deploy.md`](deploy.md) — guía de deploy existente con **procedimientos legacy**. **Requiere validación operativa
  antes de utilizarse para habilitar producción multiempresa**; sus pasos **no** fueron validados en esta consolidación.

## 12. Procedencia (qué se verificó READ-ONLY en esta consolidación)
- `git -C <repo> rev-parse HEAD` → `f2a9bf3…`; runtime en `f2a9bf3`, árbol limpio (porcelain 0). **[V]**
- `git log` y `git branch --merged main` → confirmación de commits y de ramas `feat/*` merged. **[V]**
- Inventario de `docs/` (3 archivos) y cabeceras de los cierres GAP-1/MT-1G. **[V]**
- Existencia y muestreo de checkpoints de evidencia (FF_EXIT=0; actas G-MIG CP-F/CP-H3). **[V]**
- Evidencia propia de la serie CERT-TOOLING (FIX-6C `67ee26b8`, ACCEPT-6C `360830d4`). **[V]**
- ATLAS-CERT-729 y MT-1G G1–G7: **citados** de los cierres, **no re-ejecutados**. **[C]**
- Mapa Maestro V1.1: **no disponible localmente**. **[N/L]**

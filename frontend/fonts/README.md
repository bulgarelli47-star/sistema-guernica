# Atlas OS — Fuentes locales

Carpeta reservada para fuentes tipográficas institucionales.

## Fuente activa: Space Grotesk (para "ATLAS OS")

Actualmente se carga desde Google Fonts CDN via nav-permissions.js.
Para producción offline, colocar aquí los archivos .woff2 y activar @font-face local.

### Descarga
https://fonts.google.com/specimen/Space+Grotesk
Peso requerido: 700, 800

### Activación local (cuando se descarguen)

Agregar en nav-permissions.js dentro de applyBrandTypography(), reemplazar el link CDN por:

```css
@font-face {
  font-family: 'Space Grotesk';
  src: url('/fonts/SpaceGrotesk-Bold.woff2') format('woff2');
  font-weight: 700 800;
  font-display: swap;
}
```

## Uso
- "ATLAS OS" en header/sidebar: Space Grotesk 800
- Resto del sistema: Segoe UI (tipografía del sistema operativo)

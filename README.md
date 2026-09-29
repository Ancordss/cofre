# Cofre

Control de gastos fijos, suscripciones, presupuestos por categoría, metas de ahorro y deuda de
tarjetas — para un hogar en Guatemala, en quetzales y dólares.

No es una hoja de cálculo: es una app con base de datos propia, sincronizada entre dispositivos, y
con un servidor MCP para que un agente pueda leer y modificar los datos.

## Cómo funciona

Un solo contenedor con tres puertas:

```
            ┌──────────────────────────────┐
   web  ──▶ │  /            la app         │
  MCP   ──▶ │  /mcp         36 herramientas│ ──▶  SQLite (volumen /data)
  agentes──▶│  /api/*       REST + login   │
            └──────────────────────────────┘
                    Traefik + Let's Encrypt
```

Bun + SQLite, sin dependencias externas ni build step. El servidor es la única fuente de verdad:
la app no guarda nada localmente.

## El modelo

Cada gasto tiene un **medio de pago**: efectivo o tarjeta. Lo que se carga a la tarjeta no sale del
efectivo del mes — se acumula y se paga el mes siguiente.

```
Cascada de efectivo
  ingreso + arrastre
  − gastos fijos EN EFECTIVO
  − suscripciones EN EFECTIVO
  = disponible del mes
  − presupuestos por categoría
  − aportes a metas
  = libre para asignar

Ciclo de la tarjeta
  deuda que traes
  + lo cargado este mes (fijos, suscripciones y variables en tarjeta)
  + los gastos previstos
  = deuda que pagarás el próximo mes

Margen para gastar
  ingreso esperado del próximo mes
  − esa deuda
  − los fijos que pagarás en efectivo
  − presupuestos y metas
  = puedes gastar todavía con la tarjeta
```

Al **cerrar el mes** el mes queda congelado en el historial: cambiarlo después no reescribe el pasado.
Los gastos fijos ya marcados viajan al mes nuevo también marcados (en esta casa los fijos del mes
siguiente se pagan a fin de mes).

## Estructura

```
server.js            backend: API, MCP, base de datos y el chat con el modelo
public/index.html    la app entera: HTML, CSS y JS, sin dependencias
Dockerfile           imagen de producción
docker-compose.yml   definición para Dokploy
deploy.sh            copia el código al servidor y dispara el redespliegue
```

## Correr en local

```bash
APP_PASSWORD=loquesea API_TOKEN=tok_local DB_PATH=/tmp/cofre.db PORT=3000 bun run server.js
```

Variables de entorno:

| Variable | Para qué |
|---|---|
| `APP_PASSWORD` | contraseña de la app. Obligatoria: sin ella el servidor no arranca |
| `API_TOKEN` | token fijo para clientes MCP y agentes |
| `DB_PATH` | ruta del SQLite (por omisión `/data/app.db`) |
| `PORT` | puerto (por omisión 3000) |
| `CMD_API_KEY` | clave del modelo que responde el chat de la app |
| `LLM_MODEL` | modelo del chat (por omisión `deepseek/deepseek-v4.1-flash`) |

## MCP

El endpoint vive en `/mcp` (Streamable HTTP, JSON-RPC 2.0). Necesita `Authorization: Bearer <API_TOKEN>`.

36 herramientas en español: `estado`, `resumen`, `fijar_ingreso`, `agregar_gasto`, `editar_gasto`,
`marcar_gasto`, `marcar_todos`, `eliminar_gasto`, `agregar_suscripcion`, `editar_suscripcion`,
`eliminar_suscripcion`, `fijar_tipo_cambio`, `traer_tipo_cambio`, `agregar_categoria`,
`editar_categoria`, `presupuestar_categoria`, `eliminar_categoria`, `registrar_gasto`, `borrar_gasto`,
`crear_meta`, `aportar_meta`, `editar_meta`, `eliminar_meta`, `fijar_saldo_inicial`,
`fijar_ingreso_proximo`, `fijar_limite_tarjetas`, `agregar_previsto`, `marcar_previsto`,
`editar_previsto`, `eliminar_previsto`, `agregar_tarjeta`, `anotar_tarjeta`, `eliminar_tarjeta`,
`agregar_mes`, `cerrar_mes`, `ver_historial`.

## Desplegar

```bash
export DOKPLOY_API_KEY="…"  CTP_SSH="usuario@servidor"
./deploy.sh
```

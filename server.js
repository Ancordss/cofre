#!/usr/bin/env bun
"use strict";
/**
 * Cofre — servidor único.
 *   /            la app (estático)
 *   /api/*       REST para la app
 *   /mcp         MCP remoto (Streamable HTTP, JSON-RPC 2.0)
 *   /health      liveness
 * Persistencia: SQLite en DB_PATH.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || "/data/app.db";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const API_TOKEN = process.env.API_TOKEN || "";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 180);
const COOKIE = "cofre_token";
const PUBLIC_DIR = join(import.meta.dir, "public");
const VERSION = "2.0.0";
const USD_DEFAULT = 7.6348;          // GTQ por USD, referencial; se puede fijar a mano
const LLM_URL = process.env.LLM_BASE_URL || "https://api.commandcode.ai/provider/v1";
const LLM_KEY = process.env.CMD_API_KEY || process.env.LLM_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "deepseek/deepseek-v4.1-flash";

if (!APP_PASSWORD) {
  console.error("FATAL: falta APP_PASSWORD. No arranco sin contraseña.");
  process.exit(1);
}

/* ───────────────────────────── base de datos ───────────────────────────── */
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH, { create: true });
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ingreso REAL NOT NULL DEFAULT 0,
    mes TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id TEXT PRIMARY KEY, nombre TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0,
    dia TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '',
    pagado INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS months (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, pos INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, nombre TEXT NOT NULL, saldo REAL NOT NULL DEFAULT 0, pos INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS balances (
    card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    month_id TEXT NOT NULL REFERENCES months(id) ON DELETE CASCADE,
    amount REAL NOT NULL, PRIMARY KEY (card_id, month_id)
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, nombre TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0,
    moneda TEXT NOT NULL DEFAULT 'GTQ', dia TEXT NOT NULL DEFAULT '',
    activa INTEGER NOT NULL DEFAULT 1, nota TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, nombre TEXT NOT NULL,
    presupuesto REAL NOT NULL DEFAULT 0, pos INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS spendings (
    id TEXT PRIMARY KEY, category_id TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0,
    fecha TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', mes TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY, nombre TEXT NOT NULL, objetivo REAL NOT NULL DEFAULT 0,
    inicial REAL NOT NULL DEFAULT 0, aporte_mensual REAL NOT NULL DEFAULT 0,
    fecha_limite TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS goal_log (
    id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0,
    fecha TEXT NOT NULL DEFAULT '', mes TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS card_limits (
    mes TEXT PRIMARY KEY, limite REAL NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS planned (
    id TEXT PRIMARY KEY, nombre TEXT NOT NULL, monto REAL NOT NULL DEFAULT 0,
    fecha TEXT NOT NULL DEFAULT '', hecho INTEGER NOT NULL DEFAULT 0,
    mes TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS closed_months (
    mes TEXT PRIMARY KEY,
    cerrado_en TEXT NOT NULL,
    datos TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spendings_mes ON spendings(mes);
  CREATE INDEX IF NOT EXISTS idx_goal_log_goal ON goal_log(goal_id);
`);

/* migración: columnas nuevas (idempotente) */
function agregarColumna(tabla, columna, definicion) {
  const cols = db.query(`PRAGMA table_info(${tabla})`).all().map(c => c.name);
  if (!cols.includes(columna)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
}
/* medio de pago: 'efectivo' o 'tarjeta'. Se elige gasto por gasto. */
agregarColumna("expenses", "medio", "TEXT NOT NULL DEFAULT 'efectivo'");
agregarColumna("subscriptions", "medio", "TEXT NOT NULL DEFAULT 'efectivo'");
/* El medio lo define la CATEGORÍA: cada gasto registrado ahí lo hereda.
   La columna spendings.medio queda en la base pero ya no se usa. */
agregarColumna("categories", "medio", "TEXT NOT NULL DEFAULT 'tarjeta'");
agregarColumna("settings", "ingreso_proximo", "REAL NOT NULL DEFAULT 0");

const columnasSettings = db.query("PRAGMA table_info(settings)").all().map(c => c.name);
if (!columnasSettings.includes("usd_gtq"))
  db.exec(`ALTER TABLE settings ADD COLUMN usd_gtq REAL NOT NULL DEFAULT ${USD_DEFAULT}`);
if (!columnasSettings.includes("saldo_inicial"))
  db.exec(`ALTER TABLE settings ADD COLUMN saldo_inicial REAL NOT NULL DEFAULT 0`);
if (!columnasSettings.includes("moneda_base"))
  db.exec(`ALTER TABLE settings ADD COLUMN moneda_base TEXT NOT NULL DEFAULT 'GTQ'`);

const uid = () => randomBytes(5).toString("hex");
const metaGet = k => db.query("SELECT value FROM meta WHERE key = ?").get(k)?.value ?? null;
const metaSet = (k, v) => db.query(
  "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
).run(k, String(v));

/* semilla inicial — solo la primera vez que arranca el servidor */
if (metaGet("seeded") !== "1") {
  const seedExpenses = [
    ["Comida", 3000], ["Casa", 6850.2], ["Luz", 300], ["Internet", 365], ["Agua", 160],
    ["Mantenimiento", 500], ["Teléfono", 335], ["Cuchubal", 1000],
    ["Universidad Lizie", 990], ["Universidad mía", 1790],
  ];
  const seedMonths = ["Sep 2026", "Oct 2026", "Nov 2026", "Dic 2026", "Ene 2027", "Feb 2027"];
  const seedCards = [["Visa principal", 26855.06], ["Segunda", 9874], ["Tercera", 6647.78]];
  db.transaction(() => {
    db.query("INSERT OR REPLACE INTO settings(id,ingreso,mes) VALUES(1,?,?)").run(51273, "Sep 2026");
    seedExpenses.forEach(([n, m], i) => db.query(
      "INSERT INTO expenses(id,nombre,monto,dia,nota,pagado,pos) VALUES(?,?,?,'','',0,?)"
    ).run(uid() + i, n, m, i));
    seedMonths.forEach((l, i) => db.query("INSERT INTO months(id,label,pos) VALUES(?,?,?)")
      .run(uid() + "m" + i, l, i));
    seedCards.forEach(([n, s], i) => db.query("INSERT INTO cards(id,nombre,saldo,pos) VALUES(?,?,?,?)")
      .run(uid() + "c" + i, n, s, i));
    metaSet("seeded", "1");
    metaSet("rev", "0");
  })();
  console.log("base sembrada con los datos iniciales");
}

/* categorías de gasto: se siembran una vez, con presupuestos de arranque */
if (metaGet("cat_seeded") !== "1") {
  const base = [
    ["Súper / mercado", 2000], ["Restaurantes", 1200], ["Transporte", 800],
    ["Recreación", 600], ["Ropa", 400], ["Salud", 400], ["Imprevistos", 600],
  ];
  db.transaction(() => {
    base.forEach(([n, p], i) => db.query(
      "INSERT INTO categories(id,nombre,presupuesto,pos) VALUES(?,?,?,?)"
    ).run(uid() + "k" + i, n, p, i));
    metaSet("cat_seeded", "1");
    metaSet("rev", String(Number(metaGet("rev") || 0) + 1));
  })();
  console.log("categorías de gasto creadas con presupuestos de arranque");
}

const bumpRev = () => { const r = Number(metaGet("rev") || 0) + 1; metaSet("rev", r); return r; };
const rev = () => Number(metaGet("rev") || 0);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ───────────────────────────── estado ───────────────────────────── */
function readState() {
  const s = db.query("SELECT ingreso, mes, usd_gtq, moneda_base, saldo_inicial, ingreso_proximo FROM settings WHERE id = 1")
    .get() || { ingreso: 0, mes: "", usd_gtq: USD_DEFAULT, moneda_base: "GTQ",
                saldo_inicial: 0, ingreso_proximo: 0 };
  const saldos = db.query("SELECT card_id, month_id, amount FROM balances").all();
  const porTarjeta = new Map();
  for (const b of saldos) {
    if (!porTarjeta.has(b.card_id)) porTarjeta.set(b.card_id, {});
    porTarjeta.get(b.card_id)[b.month_id] = b.amount;
  }
  return {
    ingreso: s.ingreso, mes: s.mes, usdGtq: s.usd_gtq, monedaBase: s.moneda_base,
    saldoInicial: s.saldo_inicial, ingresoProximo: s.ingreso_proximo,
    gastos: db.query("SELECT id,nombre,monto,dia,nota,pagado,medio FROM expenses ORDER BY pos").all()
      .map(g => ({ ...g, pagado: !!g.pagado })),
    meses: db.query("SELECT id,label FROM months ORDER BY pos").all(),
    tarjetas: db.query("SELECT id,nombre,saldo FROM cards ORDER BY pos").all()
      .map(c => ({ ...c, quedas: porTarjeta.get(c.id) || {} })),
    suscripciones: db.query(
      "SELECT id,nombre,monto,moneda,dia,activa,nota,medio FROM subscriptions ORDER BY pos"
    ).all().map(x => ({ ...x, activa: !!x.activa })),
    categorias: db.query("SELECT id,nombre,presupuesto,medio FROM categories ORDER BY pos").all(),
    consumos: db.query(
      "SELECT id,category_id AS categoriaId,monto,fecha,nota,mes FROM spendings ORDER BY rowid DESC"
    ).all(),
    metas: db.query(
      "SELECT id,nombre,objetivo,inicial,aporte_mensual AS aporteMensual,fecha_limite AS fechaLimite,nota FROM goals ORDER BY pos"
    ).all(),
    aportes: db.query(
      "SELECT id,goal_id AS metaId,monto,fecha,mes FROM goal_log ORDER BY rowid DESC"
    ).all(),
    limites: db.query("SELECT mes, limite FROM card_limits").all(),
    cerrados: db.query("SELECT mes, cerrado_en, datos FROM closed_months ORDER BY cerrado_en").all()
      .map(c => ({ mes: c.mes, cerradoEn: c.cerrado_en, resumen: JSON.parse(c.datos).resumen })),
    previstos: db.query(
      "SELECT id,nombre,monto,fecha,hecho,mes FROM planned ORDER BY pos"
    ).all().map(x => ({ ...x, hecho: !!x.hecho })),
  };
}

/* Sólo se reemplazan las colecciones presentes en el payload: así un cliente
   viejo (sin los campos nuevos) no puede borrar suscripciones, categorías ni metas. */
function writeState(st) {
  const tiene = k => Array.isArray(st[k]);
  db.transaction(() => {
    db.query("UPDATE settings SET ingreso = ?, mes = ?, usd_gtq = ?, saldo_inicial = ?, ingreso_proximo = ? WHERE id = 1")
      .run(num(st.ingreso), String(st.mes ?? ""), num(st.usdGtq, USD_DEFAULT),
           num(st.saldoInicial), num(st.ingresoProximo));
    if (tiene("gastos")) {
      db.query("DELETE FROM expenses").run();
      st.gastos.forEach((g, i) => db.query(
        "INSERT INTO expenses(id,nombre,monto,dia,nota,pagado,pos,medio) VALUES(?,?,?,?,?,?,?,?)"
      ).run(g.id || uid(), String(g.nombre ?? ""), num(g.monto), String(g.dia ?? ""),
            String(g.nota ?? ""), g.pagado ? 1 : 0, i, g.medio === "tarjeta" ? "tarjeta" : "efectivo"));
    }
    if (tiene("meses")) {
      const vigentes = st.meses.map(m => String(m.id));
      if (vigentes.length) {
        db.query(`DELETE FROM balances WHERE month_id NOT IN (${vigentes.map(() => "?").join(",")})`)
          .run(...vigentes);
        db.query(`DELETE FROM months WHERE id NOT IN (${vigentes.map(() => "?").join(",")})`)
          .run(...vigentes);
      }
      st.meses.forEach((m, i) => db.query(
        "INSERT INTO months(id,label,pos) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, pos=excluded.pos"
      ).run(String(m.id), String(m.label ?? ""), i));
    }
    if (tiene("tarjetas")) {
      db.query("DELETE FROM balances").run();
      db.query("DELETE FROM cards").run();
      st.tarjetas.forEach((c, i) => {
        db.query("INSERT INTO cards(id,nombre,saldo,pos) VALUES(?,?,?,?)")
          .run(c.id || uid(), String(c.nombre ?? ""), num(c.saldo), i);
        for (const [mid, v] of Object.entries(c.quedas || {})) {
          const n = num(v, null);
          if (n !== null && db.query("SELECT 1 FROM months WHERE id = ?").get(mid))
            db.query("INSERT OR REPLACE INTO balances(card_id,month_id,amount) VALUES(?,?,?)")
              .run(c.id, mid, n);
        }
      });
    }
    if (tiene("suscripciones")) {
      db.query("DELETE FROM subscriptions").run();
      st.suscripciones.forEach((s, i) => db.query(
        "INSERT INTO subscriptions(id,nombre,monto,moneda,dia,activa,nota,pos,medio) VALUES(?,?,?,?,?,?,?,?,?)"
      ).run(s.id || uid(), String(s.nombre ?? ""), num(s.monto),
            s.moneda === "USD" ? "USD" : "GTQ", String(s.dia ?? ""), s.activa ? 1 : 0,
            String(s.nota ?? ""), i, s.medio === "tarjeta" ? "tarjeta" : "efectivo"));
    }
    if (tiene("categorias")) {
      db.query("DELETE FROM spendings").run();
      db.query("DELETE FROM categories").run();
      st.categorias.forEach((c, i) => db.query(
        "INSERT INTO categories(id,nombre,presupuesto,pos,medio) VALUES(?,?,?,?,?)"
      ).run(c.id || uid(), String(c.nombre ?? ""), num(c.presupuesto), i,
            c.medio === "efectivo" ? "efectivo" : "tarjeta"));
      for (const g of (st.consumos || [])) {
        if (!db.query("SELECT 1 FROM categories WHERE id = ?").get(g.categoriaId)) continue;
        db.query("INSERT INTO spendings(id,category_id,monto,fecha,nota,mes) VALUES(?,?,?,?,?,?)")
          .run(g.id || uid(), g.categoriaId, num(g.monto), String(g.fecha ?? ""),
                String(g.nota ?? ""), String(g.mes ?? ""));
      }
    }
    if (tiene("limites")) {
      db.query("DELETE FROM card_limits").run();
      for (const l of st.limites)
        db.query("INSERT OR REPLACE INTO card_limits(mes,limite) VALUES(?,?)")
          .run(String(l.mes ?? ""), num(l.limite));
    }
    if (tiene("previstos")) {
      db.query("DELETE FROM planned").run();
      st.previstos.forEach((x, i) => db.query(
        "INSERT INTO planned(id,nombre,monto,fecha,hecho,mes,pos) VALUES(?,?,?,?,?,?,?)"
      ).run(x.id || uid(), String(x.nombre ?? ""), num(x.monto), String(x.fecha ?? ""),
            x.hecho ? 1 : 0, String(x.mes ?? ""), i));
    }
    if (tiene("metas")) {
      db.query("DELETE FROM goal_log").run();
      db.query("DELETE FROM goals").run();
      st.metas.forEach((m, i) => db.query(
        "INSERT INTO goals(id,nombre,objetivo,inicial,aporte_mensual,fecha_limite,nota,pos) VALUES(?,?,?,?,?,?,?,?)"
      ).run(m.id || uid(), String(m.nombre ?? ""), num(m.objetivo), num(m.inicial),
            num(m.aporteMensual), String(m.fechaLimite ?? ""), String(m.nota ?? ""), i));
      for (const a of (st.aportes || [])) {
        if (!db.query("SELECT 1 FROM goals WHERE id = ?").get(a.metaId)) continue;
        db.query("INSERT INTO goal_log(id,goal_id,monto,fecha,mes) VALUES(?,?,?,?,?)")
          .run(a.id || uid(), a.metaId, num(a.monto), String(a.fecha ?? ""), String(a.mes ?? ""));
      }
    }
  })();
  return bumpRev();
}

function normalizar(st) {
  st = st && typeof st === "object" ? st : {};
  const out = {};
  if (Number.isFinite(Number(st.ingreso))) out.ingreso = num(st.ingreso);
  out.mes = String(st.mes ?? "");
  out.usdGtq = num(st.usdGtq, USD_DEFAULT);
  out.saldoInicial = num(st.saldoInicial);
  out.ingresoProximo = num(st.ingresoProximo);
  if (Array.isArray(st.gastos)) out.gastos = st.gastos.map(g => ({
    id: String(g.id || uid()), nombre: String(g.nombre ?? ""), monto: num(g.monto),
    dia: String(g.dia ?? ""), nota: String(g.nota ?? ""), pagado: !!g.pagado,
    medio: g.medio === "tarjeta" ? "tarjeta" : "efectivo",
  }));
  if (Array.isArray(st.meses)) out.meses = st.meses.map(m => ({
    id: String(m.id || uid()), label: String(m.label ?? ""),
  }));
  if (Array.isArray(st.tarjetas)) out.tarjetas = st.tarjetas.map(c => ({
    id: String(c.id || uid()), nombre: String(c.nombre ?? ""), saldo: num(c.saldo),
    quedas: Object.fromEntries(Object.entries(c.quedas || {})
      .map(([k, v]) => [k, num(v, NaN)]).filter(([, v]) => Number.isFinite(v))),
  }));
  if (Array.isArray(st.suscripciones)) out.suscripciones = st.suscripciones.map(s => ({
    id: String(s.id || uid()), nombre: String(s.nombre ?? ""), monto: num(s.monto),
    moneda: s.moneda === "USD" ? "USD" : "GTQ", dia: String(s.dia ?? ""),
    activa: s.activa === undefined ? true : !!s.activa, nota: String(s.nota ?? ""),
    medio: s.medio === "tarjeta" ? "tarjeta" : "efectivo",
  }));
  if (Array.isArray(st.categorias)) out.categorias = st.categorias.map(c => ({
    id: String(c.id || uid()), nombre: String(c.nombre ?? ""), presupuesto: num(c.presupuesto),
    medio: c.medio === "efectivo" ? "efectivo" : "tarjeta",
  }));
  if (Array.isArray(st.consumos)) out.consumos = st.consumos.map(g => ({
    id: String(g.id || uid()), categoriaId: String(g.categoriaId ?? ""), monto: num(g.monto),
    fecha: String(g.fecha ?? ""), nota: String(g.nota ?? ""), mes: String(g.mes ?? ""),
  }));
  if (Array.isArray(st.metas)) out.metas = st.metas.map(m => ({
    id: String(m.id || uid()), nombre: String(m.nombre ?? ""), objetivo: num(m.objetivo),
    inicial: num(m.inicial), aporteMensual: num(m.aporteMensual),
    fechaLimite: String(m.fechaLimite ?? ""), nota: String(m.nota ?? ""),
  }));
  if (Array.isArray(st.limites)) out.limites = st.limites.map(l => ({
    mes: String(l.mes ?? ""), limite: num(l.limite),
  }));
  if (Array.isArray(st.previstos)) out.previstos = st.previstos.map(x => ({
    id: String(x.id || uid()), nombre: String(x.nombre ?? ""), monto: num(x.monto),
    fecha: String(x.fecha ?? ""), hecho: !!x.hecho, mes: String(x.mes ?? ""),
  }));
  if (Array.isArray(st.aportes)) out.aportes = st.aportes.map(a => ({
    id: String(a.id || uid()), metaId: String(a.metaId ?? ""), monto: num(a.monto),
    fecha: String(a.fecha ?? ""), mes: String(a.mes ?? ""),
  }));
  return out;
}

/* ───────────────────────────── cuentas ───────────────────────────── */
function dinero(n, simbolo) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (v < 0 ? "−" : "") + simbolo + s;
}
const q = n => dinero(n, "Q");
const usd = n => dinero(n, "$");

function calcResumen(st = readState()) {
  const tasa = num(st.usdGtq, USD_DEFAULT);
  const asGTQ = s => s.moneda === "USD" ? num(s.monto) * tasa : num(s.monto);

  const esTarjeta = x => x.medio === "tarjeta";

  let totalFijos = 0, pagado = 0, nPag = 0, fijosEfectivo = 0, fijosTarjeta = 0;
  let fijosEfectivoPagados = 0;
  for (const g of st.gastos) {
    const m = num(g.monto);
    totalFijos += m;
    if (g.pagado) { pagado += m; nPag++; }
    if (esTarjeta(g)) fijosTarjeta += m;
    else { fijosEfectivo += m; if (g.pagado) fijosEfectivoPagados += m; }
  }

  const subs = st.suscripciones.filter(s => s.activa);
  const subsGTQ = subs.reduce((a, s) => a + asGTQ(s), 0);
  const subsEfectivo = subs.filter(s => !esTarjeta(s)).reduce((a, s) => a + asGTQ(s), 0);
  const subsTarjeta = subs.filter(esTarjeta).reduce((a, s) => a + asGTQ(s), 0);

  /* Lo que cargas a la tarjeta no sale del efectivo de este mes: se paga el mes que viene. */
  const disponible = num(st.ingreso) + num(st.saldoInicial) - fijosEfectivo - subsEfectivo;

  const presupuestado = st.categorias.reduce((a, c) => a + num(c.presupuesto), 0);
  const metasMensual = st.metas.reduce((a, m) => a + num(m.aporteMensual), 0);
  const libre = disponible - presupuestado - metasMensual;

  const delMes = st.consumos.filter(g => g.mes === st.mes);
  const gastadoMes = delMes.reduce((a, g) => a + num(g.monto), 0);
  const porCategoria = st.categorias.map(c => {
    const gastado = delMes.filter(g => g.categoriaId === c.id).reduce((a, g) => a + num(g.monto), 0);
    return { id: c.id, nombre: c.nombre, presupuesto: num(c.presupuesto), gastado,
             restante: num(c.presupuesto) - gastado };
  });

  const objetivos = st.metas.map(m => {
    const ahorrado = num(m.inicial) + st.aportes.filter(a => a.metaId === m.id)
      .reduce((a, x) => a + num(x.monto), 0);
    const faltante = Math.max(0, num(m.objetivo) - ahorrado);
    const aporte = num(m.aporteMensual);
    return { id: m.id, nombre: m.nombre, objetivo: num(m.objetivo), ahorrado, faltante,
             aporteMensual: aporte, meses: aporte > 0 ? Math.ceil(faltante / aporte) : null,
             pct: num(m.objetivo) > 0 ? Math.min(1, ahorrado / num(m.objetivo)) : 0 };
  });

  const porTarjeta = [];
  let deudaActual = 0, deudaInicial = 0;
  const pagosPorMes = {};
  for (const c of st.tarjetas) {
    /* 'saldo' es el punto de partida del historial. El 'entra' de cada mes sale del
       mes anterior, así que editar un mes NUNCA reescribe los meses ya cerrados. */
    let anterior = num(c.saldo);
    const pagos = {}, entradas = {};
    for (const m of st.meses) {
      entradas[m.id] = anterior;
      const v = c.quedas[m.id];
      if (v === undefined || v === null) continue;
      pagos[m.id] = anterior - v;
      pagosPorMes[m.id] = (pagosPorMes[m.id] || 0) + (anterior - v);
      anterior = v;
    }
    deudaActual += anterior; deudaInicial += num(c.saldo);
    porTarjeta.push({ id: c.id, nombre: c.nombre, saldo: num(c.saldo), actual: anterior,
                      pagos, entradas });
  }

  /* Lo ya pagado a tarjetas este mes sale del sobre: ese dinero ya no está disponible. */
  const mesActual = st.meses.find(m => m.label === st.mes);
  const pagadoTarjetasMes = mesActual ? (pagosPorMes[mesActual.id] || 0) : 0;
  const quedaParaTarjetas = libre - pagadoTarjetasMes;

  /* Ciclo de la tarjeta: lo que cargues este mes se paga el mes que viene. */
  const previstosMes = (st.previstos || []).filter(x => x.mes === st.mes);
  const previstoTotal = previstosMes.reduce((a, x) => a + num(x.monto), 0);
  const medioDeCategoria = id => {
    const c = st.categorias.find(x => x.id === id);
    return c && c.medio === "tarjeta" ? "tarjeta" : "efectivo";
  };
  const consumosMes = st.consumos.filter(g => g.mes === st.mes);
  const consumosEfectivo = consumosMes
    .filter(g => medioDeCategoria(g.categoriaId) === "efectivo")
    .reduce((a, g) => a + num(g.monto), 0);
  const consumosTarjeta = consumosMes
    .filter(g => medioDeCategoria(g.categoriaId) === "tarjeta")
    .reduce((a, g) => a + num(g.monto), 0);
  const cargadoTarjeta = fijosTarjeta + subsTarjeta + consumosTarjeta;
  const deudaProxima = deudaActual + cargadoTarjeta + previstoTotal;
  const margenTarjeta = num(st.ingresoProximo) - deudaProxima - fijosEfectivo - presupuestado - metasMensual;
  const topeGuardado = (st.limites || []).find(l => l.mes === st.mes);
  const tope = topeGuardado ? num(topeGuardado.limite) : null;
  const puedesGastar = tope === null ? margenTarjeta : Math.min(margenTarjeta, tope);

  return {
    mes: st.mes, ingreso: num(st.ingreso), usdGtq: tasa,
    totalGastos: totalFijos, pagado, pendiente: totalFijos - pagado,
    pagados: nPag, pendientes: st.gastos.length - nPag,
    suscripcionesGTQ: subsGTQ, suscripcionesActivas: subs.length,
    disponible, presupuestado, metasMensual, libre,
    pagadoTarjetasMes, quedaParaTarjetas, mesActualId: mesActual ? mesActual.id : null,
    saldoInicial: num(st.saldoInicial), ingresoProximo: num(st.ingresoProximo),
    fijosEfectivo, fijosTarjeta, fijosEfectivoPagados, subsEfectivo, subsTarjeta,
    consumosEfectivo, consumosTarjeta,
    cargadoTarjeta, deudaProxima, margenTarjeta, tope,
    limite: puedesGastar, limiteFijado: tope !== null,
    limiteSugerido: margenTarjeta, previstoTotal, previstosCount: previstosMes.length,
    puedesGastar, previstosMes,
    gastadoMes, presupuestoRestante: presupuestado - gastadoMes,
    porCategoria, objetivos,
    deudaInicial, deudaActual, pagosPorMes, porTarjeta,
    mesesParaLiquidar: libre > 0 && deudaActual > 0 ? Math.ceil(deudaActual / libre) : null,
  };
}

function textoEstado(st = readState()) {
  const r = calcResumen(st);
  const L = [];
  L.push(`MES ${r.mes}   ingreso ${q(r.ingreso)}   (1 USD = ${r.usdGtq} GTQ)`);
  L.push("");
  L.push("CASCADA DEL MES");
  L.push(`  Ingreso                       ${q(r.ingreso).padStart(13)}`);
  L.push(`  + Saldo inicial del mes       ${q(r.saldoInicial).padStart(13)}`);
  L.push(`  − Gastos fijos en efectivo    ${q(r.fijosEfectivo).padStart(13)}   (${r.pagados}/${st.gastos.length} pagados)`);
  L.push(`  − Suscripciones en efectivo   ${q(r.subsEfectivo).padStart(13)}   (${r.suscripcionesActivas} activas)`);
  L.push(`  = Disponible del mes          ${q(r.disponible).padStart(13)}`);
  L.push(`     (lo que cargas a la tarjeta no sale de aquí: se paga el mes que viene)`);
  L.push(`  − Presupuestos por categoría  ${q(r.presupuestado).padStart(13)}`);
  L.push(`  − Aportes a metas             ${q(r.metasMensual).padStart(13)}`);
  L.push(`  = Libre para asignar          ${q(r.libre).padStart(13)}`);
  L.push(`  − Ya pagado a tarjetas        ${q(r.pagadoTarjetasMes).padStart(13)}   (lo anotado en ${r.mes})`);
  L.push(`  = ${r.quedaParaTarjetas >= 0 ? "TE QUEDA PARA TARJETAS" : "TE PASASTE POR         "}`
    + `  ${q(r.quedaParaTarjetas).padStart(13)}`);
  L.push("");
  L.push("CICLO DE TARJETA — lo que pagarás el mes que viene");
  L.push(`  Deuda que traes               ${q(r.deudaActual).padStart(13)}`);
  L.push(`  + Cargado este mes            ${q(r.cargadoTarjeta).padStart(13)}`
    + `   (fijos ${q(r.fijosTarjeta)}, suscripciones ${q(r.subsTarjeta)}, variables ${q(r.consumosTarjeta)})`);
  L.push(`  + Gastos previstos            ${q(r.previstoTotal).padStart(13)}   (${r.previstosCount} anotados)`);
  L.push(`  = Deuda del próximo mes       ${q(r.deudaProxima).padStart(13)}`);
  L.push("");
  L.push(`  Ingreso esperado del próximo mes  ${q(r.ingresoProximo).padStart(13)}`);
  L.push(`  − Deuda del próximo mes           ${q(-r.deudaProxima).padStart(13)}`);
  L.push(`  − Fijos que pagarás en efectivo   ${q(-r.fijosEfectivo).padStart(13)}`);
  L.push(`  − Presupuestos y metas            ${q(-(r.presupuestado + r.metasMensual)).padStart(13)}`);
  L.push(`  = PUEDES GASTAR TODAVÍA           ${q(r.margenTarjeta).padStart(13)}`
    + (r.tope !== null ? `   (tope tuyo ${q(r.tope)})` : ""));
  for (const x of r.previstosMes)
    L.push(`      [${x.hecho ? "x" : " "}] ${x.nombre.padEnd(22)} ${q(x.monto).padStart(11)}`
      + `${x.fecha ? `   ${x.fecha}` : ""}   id:${x.id}`);
  L.push("");
  L.push("GASTOS FIJOS");
  for (const g of st.gastos) {
    const extra = [g.dia && `día ${g.dia}`, g.nota].filter(Boolean).join(", ");
    L.push(`  [${g.pagado ? "x" : " "}] ${g.nombre.padEnd(20)} ${q(g.monto).padStart(12)}`
      + `   ${g.medio === "tarjeta" ? "tarjeta" : "efectivo"}`
      + (extra ? `   (${extra})` : "") + `   id:${g.id}`);
  }
  L.push("");
  L.push(`SUSCRIPCIONES  (total ${q(r.suscripcionesGTQ)} al mes)`);
  if (!st.suscripciones.length) L.push("  (ninguna)");
  for (const s of st.suscripciones) {
    const monto = s.moneda === "USD" ? usd(s.monto) : q(s.monto);
    L.push(`  ${s.activa ? " " : "pausada"} ${s.nombre.padEnd(20)} ${monto.padStart(11)}`
      + ` ${s.moneda}${s.dia ? `   cobra el ${s.dia}` : ""}   id:${s.id}`);
  }
  L.push("");
  L.push(`CATEGORÍAS  (gastado este mes ${q(r.gastadoMes)} de ${q(r.presupuestado)})`);
  for (const c of r.porCategoria) {
    const barra = c.presupuesto > 0 ? ` ${Math.round((c.gastado / c.presupuesto) * 100)}%` : "";
    L.push(`  ${c.nombre.padEnd(20)} ${q(c.presupuesto).padStart(11)}`
      + ` ${(st.categorias.find(x => x.id === c.id)?.medio || "tarjeta").padEnd(9)}`
      + `   gastado ${q(c.gastado).padStart(11)}   queda ${q(c.restante).padStart(11)}`
      + `${barra}   id:${c.id}`);
  }
  L.push("");
  L.push("METAS DE AHORRO");
  if (!st.metas.length) L.push("  (ninguna)");
  for (const m of r.objetivos) {
    const eta = m.meses !== null ? `   faltan ~${m.meses} meses` : "";
    L.push(`  ${m.nombre.padEnd(20)} ${q(m.ahorrado).padStart(11)} de ${q(m.objetivo).padStart(11)}`
      + `   aportas ${q(m.aporteMensual).padStart(10)}/mes${eta}   id:${m.id}`);
  }
  L.push("");
  L.push("TARJETAS");
  for (const c of st.tarjetas) {
    const rr = r.porTarjeta.find(x => x.id === c.id);
    L.push(`  ${c.nombre}  ·  saldo inicial ${q(c.saldo)}  ·  queda ${q(rr.actual)}   id:${c.id}`);
    for (const m of st.meses) {
      const v = c.quedas[m.id];
      if (v === undefined) continue;
      L.push(`      ${m.label.padEnd(10)} entra ${q(rr.entradas[m.id]).padStart(12)}`
        + `   queda ${q(v).padStart(12)}   pago ${q(rr.pagos[m.id]).padStart(12)}`);
    }
  }
  L.push("");
  L.push(`Deuda en tarjetas: ${q(r.deudaInicial)} al inicio, ${q(r.deudaActual)} ahora`
    + (r.mesesParaLiquidar ? `  ·  con ${q(r.libre)}/mes la liquidas en ~${r.mesesParaLiquidar} meses` : ""));
  L.push("");
  const cerrados = db.query("SELECT mes, datos FROM closed_months ORDER BY cerrado_en").all();
  if (cerrados.length) {
    L.push("");
    L.push("HISTORIAL DE MESES CERRADOS");
    for (const c of cerrados) {
      const rr = JSON.parse(c.datos).resumen;
      L.push(`  ${c.mes}  ingreso ${q(rr.ingreso)} · fijos ${q(rr.fijos)} · tarjetas ${q(rr.pagadoTarjetas)}`
        + ` · variable ${q(rr.gastadoVariable)} · deuda ${q(rr.deudaInicial)} → ${q(rr.deudaFinal)}`);
    }
  }
  L.push("");
  L.push("MESES: " + st.meses.map(m => `${m.label} (${m.id})`).join(" · "));
  return L.join("\n");
}

/* ───────────────────────────── MCP ───────────────────────────── */
function hallar(tabla, buscar, etiqueta, campoNombre = "nombre") {
  const t = String(buscar || "").trim().toLowerCase();
  if (!t) throw new Error(`Me falta '${etiqueta}'.`);
  const todos = db.query(`SELECT id, ${campoNombre} AS nombre FROM ${tabla} ORDER BY pos`).all();
  const porId = todos.find(x => x.id === buscar);
  if (porId) return porId;
  const hits = todos.filter(x => String(x.nombre).toLowerCase().includes(t));
  if (!hits.length) throw new Error(
    `No encontré ningún ${etiqueta} que coincida con "${buscar}". Hay: ${todos.map(x => x.nombre).join(", ") || "ninguno"}.`);
  if (hits.length > 1) throw new Error(
    `"${buscar}" coincide con varios: ${hits.map(x => x.nombre).join(", ")}. Sé más específico.`);
  return hits[0];
}
const hallarGasto = b => hallar("expenses", b, "gasto");
const hallarTarjeta = b => hallar("cards", b, "tarjeta");
const hallarCategoria = b => hallar("categories", b, "categoría");
const hallarMeta = b => hallar("goals", b, "meta");
const hallarSuscripcion = b => hallar("subscriptions", b, "suscripción");
const hallarPrevisto = b => hallar("planned", b, "gasto previsto");
function hallarMes(buscar) {
  const t = String(buscar || "").trim().toLowerCase();
  const todos = db.query("SELECT id,label AS nombre FROM months ORDER BY pos").all();
  const m = todos.find(x => x.id === buscar) || todos.find(x => x.nombre.toLowerCase() === t)
    || todos.find(x => x.nombre.toLowerCase().includes(t));
  if (!m) throw new Error(`No hay ningún mes que coincida con "${buscar}". Meses: ${todos.map(x => x.nombre).join(", ") || "ninguno"}.`);
  return m;
}
const mesActual = () => readState().mes;
const MESES_ABREV = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
function siguienteMes(label) {
  const m = /^([A-Za-zÁÉÍÓÚáéíóú]{3})\s+(\d{4})$/.exec(String(label || ""));
  if (!m) return "";
  const i = MESES_ABREV.findIndex(x => x.toLowerCase() === m[1].toLowerCase().slice(0, 3));
  if (i < 0) return "";
  let anio = parseInt(m[2], 10), j = i + 1;
  if (j > 11) { j = 0; anio++; }
  return MESES_ABREV[j] + " " + anio;
}
function asegurarMes(label) {
  const m = db.query("SELECT id,label FROM months WHERE label = ?").get(label);
  if (m) return m;
  const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM months").get().p;
  const id = uid() + "m";
  db.query("INSERT INTO months(id,label,pos) VALUES(?,?,?)").run(id, label, pos);
  return { id, label };
}

const TOOLS = [
  {
    name: "estado",
    description: "Devuelve todo el estado actual: la cascada del mes (ingreso, gastos fijos, suscripciones, presupuestos, metas y libre para tarjetas), los gastos fijos con su estado de pago, las suscripciones con su moneda, las categorías con lo gastado, las metas de ahorro con su avance y las tarjetas con sus saldos por mes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => textoEstado(),
  },
  {
    name: "resumen",
    description: "Solo los números calculados del mes: cascada completa (disponible, presupuestos, aportes a metas, libre para asignar), cuánto se ha pagado ya a las tarjetas este mes, cuánto queda por asignarles, deuda total, meses estimados para liquidarla y avance de cada meta.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: () => JSON.stringify(calcResumen(), null, 2),
  },
  {
    name: "fijar_ingreso",
    description: "Fija el ingreso del mes en curso.",
    inputSchema: { type: "object", properties: { monto: { type: "number" } }, required: ["monto"], additionalProperties: false },
    run: ({ monto }) => {
      db.query("UPDATE settings SET ingreso = ? WHERE id = 1").run(num(monto));
      bumpRev(); return `Ingreso del mes: ${q(monto)}`;
    },
  },
  /* ── gastos fijos ── */
  {
    name: "agregar_gasto",
    description: "Agrega un gasto fijo nuevo (renta, servicios, colegiaturas). Se agrega al final y arranca como no pagado.",
    inputSchema: {
      type: "object",
      properties: { nombre: { type: "string" }, monto: { type: "number" },
        dia: { type: "string" }, nota: { type: "string" } },
      required: ["nombre", "monto"], additionalProperties: false,
    },
    run: ({ nombre, monto, dia, nota }) => {
      const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM expenses").get().p;
      const id = uid();
      db.query("INSERT INTO expenses(id,nombre,monto,dia,nota,pagado,pos) VALUES(?,?,?,?,?,0,?)")
        .run(id, String(nombre), num(monto), String(dia ?? ""), String(nota ?? ""), pos);
      bumpRev(); return `Gasto fijo agregado: ${nombre} ${q(monto)} (id ${id})`;
    },
  },
  {
    name: "editar_gasto",
    description: "Cambia el nombre, monto, día de pago o nota de un gasto fijo. Identifícalo por id o parte del nombre.",
    inputSchema: {
      type: "object",
      properties: { buscar: { type: "string" }, nombre: { type: "string" },
        monto: { type: "number" }, dia: { type: "string" }, nota: { type: "string" },
        medio: { type: "string", enum: ["efectivo", "tarjeta"],
                 description: "'tarjeta' si lo cargas a la tarjeta (se paga el mes que viene), 'efectivo' si sale de tu dinero este mes." } },
      required: ["buscar"], additionalProperties: false,
    },
    run: a => {
      const g = hallarGasto(a.buscar); const campos = [];
      for (const k of ["nombre", "monto", "dia", "nota"]) {
        if (a[k] === undefined) continue;
        db.query(`UPDATE expenses SET ${k} = ? WHERE id = ?`).run(k === "monto" ? num(a[k]) : String(a[k]), g.id);
        campos.push(`${k}=${a[k]}`);
      }
      if (a.medio !== undefined) {
        const v = a.medio === "tarjeta" ? "tarjeta" : "efectivo";
        db.query("UPDATE expenses SET medio = ? WHERE id = ?").run(v, g.id);
        campos.push(`medio=${v}`);
      }
      if (!campos.length) return "No mandaste ningún campo que cambiar.";
      bumpRev(); return `Actualizado ${g.nombre}: ${campos.join(", ")}`;
    },
  },
  {
    name: "marcar_gasto",
    description: "Marca o desmarca un gasto fijo como pagado. Identifícalo por id o parte del nombre.",
    inputSchema: {
      type: "object",
      properties: { buscar: { type: "string" }, pagado: { type: "boolean" } },
      required: ["buscar", "pagado"], additionalProperties: false,
    },
    run: ({ buscar, pagado }) => {
      const g = hallarGasto(buscar);
      db.query("UPDATE expenses SET pagado = ? WHERE id = ?").run(pagado ? 1 : 0, g.id);
      bumpRev(); return `${g.nombre} ${pagado ? "marcado como pagado" : "marcado como NO pagado"}.`;
    },
  },
  {
    name: "marcar_todos",
    description: "Marca todos los gastos fijos como pagados o como no pagados de una vez.",
    inputSchema: { type: "object", properties: { pagado: { type: "boolean" } }, required: ["pagado"], additionalProperties: false },
    run: ({ pagado }) => {
      const n = db.query("UPDATE expenses SET pagado = ?").run(pagado ? 1 : 0).changes;
      bumpRev(); return `${n} gastos marcados como ${pagado ? "pagados" : "no pagados"}.`;
    },
  },
  {
    name: "eliminar_gasto",
    description: "Borra un gasto fijo. Identifícalo por id o parte del nombre.",
    inputSchema: { type: "object", properties: { buscar: { type: "string" } }, required: ["buscar"], additionalProperties: false },
    run: ({ buscar }) => {
      const g = hallarGasto(buscar);
      db.query("DELETE FROM expenses WHERE id = ?").run(g.id);
      bumpRev(); return `Gasto fijo eliminado: ${g.nombre}.`;
    },
  },
  /* ── suscripciones ── */
  {
    name: "agregar_suscripcion",
    description: "Agrega una suscripción o servicio recurrente (streaming, software, gimnasio). Puede estar en quetzales (GTQ) o dólares (USD); si es USD se convierte con el tipo de cambio.",
    inputSchema: {
      type: "object",
      properties: { nombre: { type: "string" }, monto: { type: "number" },
        moneda: { type: "string", enum: ["GTQ", "USD"], description: "Por omisión GTQ." },
        dia: { type: "string", description: "Día del cobro." }, nota: { type: "string" } },
      required: ["nombre", "monto"], additionalProperties: false,
    },
    run: ({ nombre, monto, moneda, dia, nota }) => {
      const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM subscriptions").get().p;
      const id = uid(); const m = moneda === "USD" ? "USD" : "GTQ";
      db.query("INSERT INTO subscriptions(id,nombre,monto,moneda,dia,activa,nota,pos) VALUES(?,?,?,?,?,1,?,?)")
        .run(id, String(nombre), num(monto), m, String(dia ?? ""), String(nota ?? ""), pos);
      bumpRev();
      return `Suscripción agregada: ${nombre} ${m === "USD" ? usd(monto) : q(monto)} (${m}) (id ${id})`;
    },
  },
  {
    name: "editar_suscripcion",
    description: "Cambia el nombre, monto, moneda, día, nota o el estado activo/pausado de una suscripción. Identifícala por id o parte del nombre.",
    inputSchema: {
      type: "object",
      properties: { buscar: { type: "string" }, nombre: { type: "string" },
        monto: { type: "number" }, moneda: { type: "string", enum: ["GTQ", "USD"] },
        dia: { type: "string" }, nota: { type: "string" }, activa: { type: "boolean" },
        medio: { type: "string", enum: ["efectivo", "tarjeta"] } },
      required: ["buscar"], additionalProperties: false,
    },
    run: a => {
      const s = hallarSuscripcion(a.buscar); const campos = [];
      if (a.nombre !== undefined) { db.query("UPDATE subscriptions SET nombre=? WHERE id=?").run(String(a.nombre), s.id); campos.push("nombre"); }
      if (a.monto !== undefined) { db.query("UPDATE subscriptions SET monto=? WHERE id=?").run(num(a.monto), s.id); campos.push(`monto=${a.monto}`); }
      if (a.moneda !== undefined) { db.query("UPDATE subscriptions SET moneda=? WHERE id=?").run(a.moneda === "USD" ? "USD" : "GTQ", s.id); campos.push(`moneda=${a.moneda}`); }
      if (a.medio !== undefined) { db.query("UPDATE subscriptions SET medio=? WHERE id=?").run(a.medio === "tarjeta" ? "tarjeta" : "efectivo", s.id); campos.push(`medio=${a.medio}`); }
      if (a.dia !== undefined) { db.query("UPDATE subscriptions SET dia=? WHERE id=?").run(String(a.dia), s.id); campos.push(`dia=${a.dia}`); }
      if (a.nota !== undefined) { db.query("UPDATE subscriptions SET nota=? WHERE id=?").run(String(a.nota), s.id); campos.push("nota"); }
      if (a.activa !== undefined) { db.query("UPDATE subscriptions SET activa=? WHERE id=?").run(a.activa ? 1 : 0, s.id); campos.push(a.activa ? "activa" : "pausada"); }
      if (!campos.length) return "No mandaste ningún campo que cambiar.";
      bumpRev(); return `Suscripción ${s.nombre}: ${campos.join(", ")}`;
    },
  },
  {
    name: "eliminar_suscripcion",
    description: "Borra una suscripción. Identifícala por id o parte del nombre.",
    inputSchema: { type: "object", properties: { buscar: { type: "string" } }, required: ["buscar"], additionalProperties: false },
    run: ({ buscar }) => {
      const s = hallarSuscripcion(buscar);
      db.query("DELETE FROM subscriptions WHERE id = ?").run(s.id);
      bumpRev(); return `Suscripción eliminada: ${s.nombre}.`;
    },
  },
  {
    name: "fijar_tipo_cambio",
    description: "Fija cuántos quetzales vale un dólar, para convertir las suscripciones en USD. Pásale el valor de tu banco si prefieres ese.",
    inputSchema: { type: "object", properties: { gtq_por_usd: { type: "number" } }, required: ["gtq_por_usd"], additionalProperties: false },
    run: ({ gtq_por_usd }) => {
      db.query("UPDATE settings SET usd_gtq = ? WHERE id = 1").run(num(gtq_por_usd, USD_DEFAULT));
      bumpRev(); return `Tipo de cambio: 1 USD = ${num(gtq_por_usd, USD_DEFAULT)} GTQ`;
    },
  },
  {
    name: "traer_tipo_cambio",
    description: "Consulta el tipo de cambio del dólar contra el quetzal en este momento y lo guarda.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      const v = num(d?.rates?.GTQ, null);
      if (v === null) throw new Error("La fuente del tipo de cambio no devolvió GTQ.");
      db.query("UPDATE settings SET usd_gtq = ? WHERE id = 1").run(v);
      bumpRev(); return `Tipo de cambio actualizado: 1 USD = ${v} GTQ`;
    },
  },
  /* ── categorías y consumo ── */
  {
    name: "agregar_categoria",
    description: "Crea una categoría de gasto variable (restaurantes, recreación, transporte…) con su presupuesto mensual.",
    inputSchema: {
      type: "object",
      properties: { nombre: { type: "string" }, presupuesto: { type: "number" },
        medio: { type: "string", enum: ["efectivo", "tarjeta"],
                 description: "Con qué se paga lo de esta categoría. Por omisión 'tarjeta': lo que esté en tarjeta se suma al pago del próximo mes." } },
      required: ["nombre"], additionalProperties: false,
    },
    run: ({ nombre, presupuesto, medio }) => {
      const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM categories").get().p;
      const id = uid(); const m = medio === "efectivo" ? "efectivo" : "tarjeta";
      db.query("INSERT INTO categories(id,nombre,presupuesto,pos,medio) VALUES(?,?,?,?,?)")
        .run(id, String(nombre), num(presupuesto), pos, m);
      bumpRev();
      return `Categoría creada: ${nombre} con presupuesto ${q(presupuesto)}, pago en ${m} (id ${id})`;
    },
  },
  {
    name: "presupuestar_categoria",
    description: "Asigna o cambia el presupuesto mensual de una categoría. Identifícala por id o parte del nombre.",
    inputSchema: {
      type: "object",
      properties: { categoria: { type: "string" }, monto: { type: "number" } },
      required: ["categoria", "monto"], additionalProperties: false,
    },
    run: ({ categoria, monto }) => {
      const c = hallarCategoria(categoria);
      db.query("UPDATE categories SET presupuesto = ? WHERE id = ?").run(num(monto), c.id);
      const r = calcResumen();
      bumpRev();
      return `${c.nombre}: presupuesto ${q(monto)}. Libre para tarjetas ahora: ${q(r.libre)}`;
    },
  },
  {
    name: "editar_categoria",
    description: "Cambia el nombre, el presupuesto o el medio de pago de una categoría. El medio aplica a todos los gastos de esa categoría, presentes y futuros.",
    inputSchema: {
      type: "object",
      properties: { buscar: { type: "string" }, nombre: { type: "string" },
        presupuesto: { type: "number" }, medio: { type: "string", enum: ["efectivo", "tarjeta"] } },
      required: ["buscar"], additionalProperties: false,
    },
    run: a => {
      const c = hallarCategoria(a.buscar); const campos = [];
      if (a.nombre !== undefined) { db.query("UPDATE categories SET nombre=? WHERE id=?").run(String(a.nombre), c.id); campos.push(`nombre=${a.nombre}`); }
      if (a.presupuesto !== undefined) { db.query("UPDATE categories SET presupuesto=? WHERE id=?").run(num(a.presupuesto), c.id); campos.push(`presupuesto=${q(a.presupuesto)}`); }
      if (a.medio !== undefined) {
        const m = a.medio === "efectivo" ? "efectivo" : "tarjeta";
        db.query("UPDATE categories SET medio=? WHERE id=?").run(m, c.id); campos.push(`medio=${m}`);
      }
      if (!campos.length) return "No mandaste ningún campo que cambiar.";
      const r = calcResumen(); bumpRev();
      return `${c.nombre}: ${campos.join(", ")} · puedes gastar con la tarjeta ${q(r.margenTarjeta)}`;
    },
  },
  {
    name: "eliminar_categoria",
    description: "Borra una categoría y los gastos registrados en ella. Identifícala por id o parte del nombre.",
    inputSchema: { type: "object", properties: { categoria: { type: "string" } }, required: ["categoria"], additionalProperties: false },
    run: ({ categoria }) => {
      const c = hallarCategoria(categoria);
      db.query("DELETE FROM spendings WHERE category_id = ?").run(c.id);
      db.query("DELETE FROM categories WHERE id = ?").run(c.id);
      bumpRev(); return `Categoría eliminada: ${c.nombre}.`;
    },
  },
  {
    name: "registrar_gasto",
    description: "Registra un gasto variable del mes en una categoría (una cena, una salida, gasolina). Así se descuenta del presupuesto de esa categoría.",
    inputSchema: {
      type: "object",
      properties: {
        categoria: { type: "string", description: "id o parte del nombre de la categoría." },
        monto: { type: "number" }, nota: { type: "string" },
        fecha: { type: "string", description: "Fecha, ej. '2026-09-29'. Por omisión hoy." },
        mes: { type: "string", description: "Mes al que pertenece, ej. 'Sep 2026'. Por omisión el mes en curso." },
      },
      required: ["categoria", "monto"], additionalProperties: false,
    },
    run: ({ categoria, monto, nota, fecha, mes }) => {
      const c = hallarCategoria(categoria);
      const m = mes ? hallarMes(mes).nombre : mesActual();
      const id = uid();
      db.query("INSERT INTO spendings(id,category_id,monto,fecha,nota,mes) VALUES(?,?,?,?,?,?)")
        .run(id, c.id, num(monto), String(fecha ?? new Date().toISOString().slice(0, 10)),
              String(nota ?? ""), m);
      const r = calcResumen();
      const cat = r.porCategoria.find(x => x.id === c.id);
      bumpRev();
      return `${c.nombre}: ${q(monto)} en ${m}. Llevas ${q(cat.gastado)} de ${q(cat.presupuesto)}`
        + ` · te quedan ${q(cat.restante)}`;
    },
  },
  {
    name: "borrar_gasto",
    description: "Borra un gasto variable registrado. Identifícalo por su id (sale en 'estado').",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    run: ({ id }) => {
      const g = db.query("SELECT id, category_id FROM spendings WHERE id = ?").get(id);
      if (!g) throw new Error(`No encontré ningún gasto variable con id "${id}".`);
      db.query("DELETE FROM spendings WHERE id = ?").run(id);
      bumpRev(); return "Gasto variable borrado.";
    },
  },
  /* ── metas de ahorro ── */
  {
    name: "crear_meta",
    description: "Crea una meta de ahorro (un fondo de emergencia, un viaje, un enganche). El aporte mensual es lo que separas cada mes para esa meta.",
    inputSchema: {
      type: "object",
      properties: {
        nombre: { type: "string" }, objetivo: { type: "number" },
        ahorrado: { type: "number", description: "Lo que ya tienes apartado para esta meta." },
        aporte_mensual: { type: "number" }, fecha_limite: { type: "string" }, nota: { type: "string" },
      },
      required: ["nombre", "objetivo"], additionalProperties: false,
    },
    run: ({ nombre, objetivo, ahorrado, aporte_mensual, fecha_limite, nota }) => {
      const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM goals").get().p;
      const id = uid();
      db.query("INSERT INTO goals(id,nombre,objetivo,inicial,aporte_mensual,fecha_limite,nota,pos) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, String(nombre), num(objetivo), num(ahorrado), num(aporte_mensual),
              String(fecha_limite ?? ""), String(nota ?? ""), pos);
      const r = calcResumen(); const m = r.objetivos.find(x => x.id === id);
      bumpRev();
      return `Meta "${nombre}" creada: ${q(objetivo)}, ya tienes ${q(ahorrado)}`
        + (m.meses !== null ? `, la alcanzas en ~${m.meses} meses` : "") + ` (id ${id})`;
    },
  },
  {
    name: "aportar_meta",
    description: "Registra un aporte a una meta de ahorro. Suma al acumulado y queda en el historial del mes.",
    inputSchema: {
      type: "object",
      properties: { meta: { type: "string" }, monto: { type: "number" },
        mes: { type: "string", description: "Por omisión el mes en curso." } },
      required: ["meta", "monto"], additionalProperties: false,
    },
    run: ({ meta, monto, mes }) => {
      const m = hallarMeta(meta);
      const etiqueta = mes ? hallarMes(mes).nombre : mesActual();
      db.query("INSERT INTO goal_log(id,goal_id,monto,fecha,mes) VALUES(?,?,?,?,?)")
        .run(uid(), m.id, num(monto), new Date().toISOString().slice(0, 10), etiqueta);
      const r = calcResumen(); const o = r.objetivos.find(x => x.id === m.id);
      bumpRev();
      return `${m.nombre}: +${q(monto)}. Llevas ${q(o.ahorrado)} de ${q(o.objetivo)}`
        + (o.faltante > 0 ? ` · faltan ${q(o.faltante)}` : " · ¡meta alcanzada!");
    },
  },
  {
    name: "editar_meta",
    description: "Cambia el nombre, el objetivo, el aporte mensual, la fecha límite o la nota de una meta. Identifícala por id o parte del nombre.",
    inputSchema: {
      type: "object",
      properties: { buscar: { type: "string" }, nombre: { type: "string" },
        objetivo: { type: "number" }, aporte_mensual: { type: "number" },
        fecha_limite: { type: "string" }, nota: { type: "string" } },
      required: ["buscar"], additionalProperties: false,
    },
    run: a => {
      const m = hallarMeta(a.buscar); const campos = [];
      const mapa = { nombre: "nombre", objetivo: "objetivo", aporte_mensual: "aporte_mensual",
                     fecha_limite: "fecha_limite", nota: "nota" };
      for (const [k, col] of Object.entries(mapa)) {
        if (a[k] === undefined) continue;
        db.query(`UPDATE goals SET ${col} = ? WHERE id = ?`)
          .run(k === "nombre" || k === "fecha_limite" || k === "nota" ? String(a[k]) : num(a[k]), m.id);
        campos.push(`${k}=${a[k]}`);
      }
      if (!campos.length) return "No mandaste ningún campo que cambiar.";
      const r = calcResumen(); const o = r.objetivos.find(x => x.id === m.id);
      bumpRev();
      return `Meta ${m.nombre} actualizada: ${campos.join(", ")}`
        + ` · libre para tarjetas ahora ${q(r.libre)}`
        + (o.meses !== null ? ` · la alcanzas en ~${o.meses} meses` : "");
    },
  },
  {
    name: "eliminar_meta",
    description: "Borra una meta de ahorro y su historial de aportes. Identifícala por id o parte del nombre.",
    inputSchema: { type: "object", properties: { meta: { type: "string" } }, required: ["meta"], additionalProperties: false },
    run: ({ meta }) => {
      const m = hallarMeta(meta);
      db.query("DELETE FROM goal_log WHERE goal_id = ?").run(m.id);
      db.query("DELETE FROM goals WHERE id = ?").run(m.id);
      bumpRev(); return `Meta eliminada: ${m.nombre}.`;
    },
  },
  /* ── límite de gasto con tarjetas ── */
  {
    name: "fijar_saldo_inicial",
    description: "Fija cuánto dinero traías al empezar el mes (lo que sobró del mes anterior). Se suma al ingreso en la cascada, para que el cuadre refleje la realidad y no marque un faltante que ya estaba cubierto.",
    inputSchema: { type: "object", properties: { monto: { type: "number" } }, required: ["monto"], additionalProperties: false },
    run: ({ monto }) => {
      db.query("UPDATE settings SET saldo_inicial = ? WHERE id = 1").run(num(monto));
      const r = calcResumen(); bumpRev();
      return `Saldo inicial del mes: ${q(monto)} · disponible del mes ahora ${q(r.disponible)} · te queda para tarjetas ${q(r.quedaParaTarjetas)}`;
    },
  },
  {
    name: "fijar_ingreso_proximo",
    description: "Anota cuánto esperas recibir el mes que viene. Con eso se calcula el margen para gastar con la tarjeta este mes: ingreso próximo − la deuda que pagarás el mes que viene − fijos en efectivo − presupuestos y metas.",
    inputSchema: { type: "object", properties: { monto: { type: "number" } }, required: ["monto"], additionalProperties: false },
    run: ({ monto }) => {
      db.query("UPDATE settings SET ingreso_proximo = ? WHERE id = 1").run(num(monto));
      const r = calcResumen(); bumpRev();
      return `Ingreso esperado del próximo mes: ${q(monto)} · deuda del próximo mes ${q(r.deudaProxima)}`
        + ` · puedes gastar todavía ${q(r.margenTarjeta)}`;
    },
  },
  {
    name: "fijar_limite_tarjetas",
    description: "Pone un tope propio (opcional) al gasto con tarjeta de este mes. Si lo pones por debajo del margen calculado, manda el tuyo. Pásale 0 para quitar el tope y volver al cálculo.",
    inputSchema: {
      type: "object",
      properties: { monto: { type: "number" }, mes: { type: "string", description: "Por omisión el mes en curso." } },
      required: ["monto"], additionalProperties: false,
    },
    run: ({ monto, mes }) => {
      const m = mes ? hallarMes(mes).nombre : mesActual();
      if (!num(monto)) {
        db.query("DELETE FROM card_limits WHERE mes = ?").run(m);
        const r = calcResumen(); bumpRev();
        return `Tope quitado para ${m}. Vuelvo al cálculo: puedes gastar ${q(r.margenTarjeta)}`;
      }
      db.query("INSERT OR REPLACE INTO card_limits(mes,limite) VALUES(?,?)").run(m, num(monto));
      const r = calcResumen(); bumpRev();
      return `Tope propio para ${m}: ${q(monto)} (el cálculo daba ${q(r.margenTarjeta)})`
        + ` · puedes gastar ${q(r.puedesGastar)}`;
    },
  },
  {
    name: "agregar_previsto",
    description: "Anota un gasto que vas a hacer con la tarjeta (una cena, un pago, una compra). Se descuenta del límite para que no te pases. Distinto de 'registrar_gasto', que es dinero ya gastado y va contra el presupuesto de una categoría.",
    inputSchema: {
      type: "object",
      properties: { nombre: { type: "string" }, monto: { type: "number" },
        fecha: { type: "string", description: "Cuándo lo harás, ej. '2026-10-03'." } },
      required: ["nombre", "monto"], additionalProperties: false,
    },
    run: ({ nombre, monto, fecha }) => {
      const mes = mesActual();
      const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM planned").get().p;
      const id = uid();
      db.query("INSERT INTO planned(id,nombre,monto,fecha,hecho,mes,pos) VALUES(?,?,?,?,0,?,?)")
        .run(id, String(nombre), num(monto), String(fecha ?? ""), mes, pos);
      const r = calcResumen(); bumpRev();
      return `Previsto "${nombre}" ${q(monto)} en ${mes} (id ${id}). Total previsto ${q(r.previstoTotal)}`
        + ` · puedes gastar todavía ${q(r.puedesGastar)}`;
    },
  },
  {
    name: "marcar_previsto",
    description: "Marca un gasto previsto como ya hecho (o lo devuelve a pendiente). No cambia los montos, solo el estado.",
    inputSchema: {
      type: "object",
      properties: { buscar: { type: "string" }, hecho: { type: "boolean" } },
      required: ["buscar", "hecho"], additionalProperties: false,
    },
    run: ({ buscar, hecho }) => {
      const x = hallarPrevisto(buscar);
      db.query("UPDATE planned SET hecho = ? WHERE id = ?").run(hecho ? 1 : 0, x.id);
      const r = calcResumen(); bumpRev();
      return `${x.nombre}: ${hecho ? "marcado como hecho" : "de vuelta a pendiente"}. Puedes gastar todavía ${q(r.puedesGastar)}`;
    },
  },
  {
    name: "editar_previsto",
    description: "Cambia el nombre, el monto o la fecha de un gasto previsto. Identifícalo por id o parte del nombre.",
    inputSchema: {
      type: "object",
      properties: { buscar: { type: "string" }, nombre: { type: "string" },
        monto: { type: "number" }, fecha: { type: "string" } },
      required: ["buscar"], additionalProperties: false,
    },
    run: a => {
      const x = hallarPrevisto(a.buscar); const campos = [];
      for (const k of ["nombre", "monto", "fecha"]) {
        if (a[k] === undefined) continue;
        db.query(`UPDATE planned SET ${k} = ? WHERE id = ?`).run(k === "monto" ? num(a[k]) : String(a[k]), x.id);
        campos.push(`${k}=${a[k]}`);
      }
      if (!campos.length) return "No mandaste ningún campo que cambiar.";
      const r = calcResumen(); bumpRev();
      return `${x.nombre}: ${campos.join(", ")} · puedes gastar todavía ${q(r.puedesGastar)}`;
    },
  },
  {
    name: "eliminar_previsto",
    description: "Borra un gasto previsto de la lista.",
    inputSchema: { type: "object", properties: { buscar: { type: "string" } }, required: ["buscar"], additionalProperties: false },
    run: ({ buscar }) => {
      const x = hallarPrevisto(buscar);
      db.query("DELETE FROM planned WHERE id = ?").run(x.id);
      bumpRev(); return `Gasto previsto eliminado: ${x.nombre}.`;
    },
  },
  /* ── tarjetas ── */
  {
    name: "agregar_tarjeta",
    description: "Agrega una tarjeta de crédito con el saldo con el que arranca el historial (no el de hoy, sino el del primer mes que vas a registrar).",
    inputSchema: { type: "object", properties: { nombre: { type: "string" }, saldo: { type: "number" } }, required: ["nombre", "saldo"], additionalProperties: false },
    run: ({ nombre, saldo }) => {
      const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM cards").get().p;
      const id = uid();
      db.query("INSERT INTO cards(id,nombre,saldo,pos) VALUES(?,?,?,?)").run(id, String(nombre), num(saldo), pos);
      bumpRev(); return `Tarjeta agregada: ${nombre} con saldo ${q(saldo)} (id ${id})`;
    },
  },
  {
    name: "anotar_tarjeta",
    description: "Anota cuánto queda debiendo una tarjeta al cerrar un mes. El pago de ese mes se calcula solo (saldo anterior menos lo que queda). Esta es la acción principal de cada mes.",
    inputSchema: {
      type: "object",
      properties: { tarjeta: { type: "string" }, mes: { type: "string" },
        queda: { type: "number", description: "0 si la liquidaste." } },
      required: ["tarjeta", "mes", "queda"], additionalProperties: false,
    },
    run: ({ tarjeta, mes, queda }) => {
      const c = hallarTarjeta(tarjeta); const m = hallarMes(mes);
      const st = readState(); const card = st.tarjetas.find(x => x.id === c.id);
      let anterior = num(card.saldo);
      for (const mm of st.meses) { if (mm.id === m.id) break; const v = card.quedas[mm.id]; if (v !== undefined) anterior = v; }
      const valor = num(queda);
      db.query("INSERT OR REPLACE INTO balances(card_id,month_id,amount) VALUES(?,?,?)").run(c.id, m.id, valor);
      bumpRev();
      return `${c.nombre} · ${m.nombre}: queda ${q(valor)} · pago del mes ${q(anterior - valor)}`;
    },
  },
  {
    name: "eliminar_tarjeta",
    description: "Borra una tarjeta y todos sus saldos anotados.",
    inputSchema: { type: "object", properties: { tarjeta: { type: "string" } }, required: ["tarjeta"], additionalProperties: false },
    run: ({ tarjeta }) => {
      const c = hallarTarjeta(tarjeta);
      db.query("DELETE FROM balances WHERE card_id = ?").run(c.id);
      db.query("DELETE FROM cards WHERE id = ?").run(c.id);
      bumpRev(); return `Tarjeta eliminada: ${c.nombre}.`;
    },
  },
  {
    name: "cerrar_mes",
    description: "Cierra el mes en curso y arranca el siguiente. Congela el mes que termina en el historial, desmarca los gastos fijos, arrastra el efectivo que sobró como saldo inicial del mes nuevo y pasa el ingreso esperado a ser el ingreso del mes. Los gastos variables y los previstos del mes cerrado se quedan en ese mes. Úsalo cuando el usuario diga que van a pasar al mes siguiente.",
    inputSchema: {
      type: "object",
      properties: {
        confirmar: { type: "boolean", description: "Tiene que ser true. Sin esto no cierro nada." },
        mes: { type: "string", description: "El mes al que pasas, ej. 'Oct 2026'. Por omisión, el siguiente de la lista." },
        saldo_inicial: { type: "number", description: "Cuánto efectivo te quedó, si prefieres no usar el cálculo automático." },
        ingreso: { type: "number", description: "El ingreso del mes nuevo, si ya lo sabes. Por omisión, el ingreso esperado que tenías anotado." },
        conservar_pagados: { type: "boolean", description: "Por omisión true. Los gastos fijos que ya marcaste como pagados pasan al mes nuevo TAMBIÉN marcados, porque en esta casa se pagan los fijos del mes siguiente a fin de mes. Ponlo en false solo si los fijos que marcaste eran de verdad del mes que cierra." },
      },
      required: ["confirmar"], additionalProperties: false,
    },
    run: ({ confirmar, mes, saldo_inicial, ingreso, conservar_pagados }) => {
      if (confirmar !== true) throw new Error("No cerré nada: hace falta confirmar=true.");
      const st = readState();
      const actual = st.mes;
      if (!actual) throw new Error("No hay mes en curso anotado.");
      const destino = mes ? hallarMes(mes).nombre : siguienteMes(actual);
      if (!destino) throw new Error(`No pude deducir el mes siguiente a "${actual}". Pásame el mes al que pasas.`);
      if (destino === actual) throw new Error(`Ya estás en ${actual}.`);
      const yaEstaba = Boolean(db.query("SELECT 1 FROM closed_months WHERE mes = ?").get(actual));

      const r = calcResumen(st);
      const mesId = (st.meses.find(m => m.label === actual) || {}).id;
      const tc = id => (st.tarjetas.find(c => c.id === id) || { quedas: {} });
      const tarjetas = r.porTarjeta.map(t => {
        const q = tc(t.id).quedas[mesId];
        return { nombre: t.nombre, entra: t.entradas[mesId] ?? null,
                 queda: q === undefined ? null : q, pago: t.pagos[mesId] ?? null };
      });
      const conservar = conservar_pagados === undefined ? true : Boolean(conservar_pagados);
      const resumen = {
        ingreso: r.ingreso, saldoInicial: r.saldoInicial, fijos: r.totalGastos,
        /* si los pagos se trasladan al mes nuevo, este mes no los reclama como suyos */
        fijosPagados: conservar ? 0 : r.pagados,
        suscripciones: r.suscripcionesGTQ, disponible: r.disponible, presupuestado: r.presupuestado,
        metas: r.metasMensual, libre: r.libre, pagadoTarjetas: r.pagadoTarjetasMes,
        gastadoVariable: r.gastadoMes, deudaInicial: r.deudaInicial, deudaFinal: r.deudaActual,
        previstoTotal: r.previstoTotal,
      };
      const detalle = {
        resumen, tarjetas,
        nota: conservar && r.pagados > 0
          ? `Los ${r.pagados} pagos de gastos fijos se trasladaron a ${destino}: en esta casa los fijos del mes siguiente se pagan a fin de mes.`
          : null,
        categorias: r.porCategoria.map(c => ({ nombre: c.nombre, presupuesto: c.presupuesto, gastado: c.gastado })),
        objetivos: r.objetivos.map(o => ({ nombre: o.nombre, ahorrado: o.ahorrado, objetivo: o.objetivo })),
        gastos: st.gastos.map(g => ({ nombre: g.nombre, monto: g.monto, medio: g.medio, pagado: g.pagado })),
      };

      /* Efectivo que arrastras al mes nuevo.
         Si los pagos de fijos viajan al mes siguiente, NO se restan aquí: son gastos
         de ese mes y allá se descuentan completos. Restarlos en los dos lados era doble conteo. */
      const sobro = num(st.ingreso) + num(st.saldoInicial)
        - (conservar ? 0 : r.fijosEfectivoPagados)
        - r.subsEfectivo - r.consumosEfectivo - r.pagadoTarjetasMes;
      const saldoNuevo = saldo_inicial !== undefined ? num(saldo_inicial) : sobro;
      const ingresoNuevo = ingreso !== undefined ? num(ingreso)
        : (num(st.ingresoProximo) || num(st.ingreso));

      db.transaction(() => {
        db.query("INSERT OR REPLACE INTO closed_months(mes, cerrado_en, datos) VALUES(?,?,?)")
          .run(actual, new Date().toISOString(), JSON.stringify(detalle));
        asegurarMes(destino);
        db.query("UPDATE settings SET mes = ?, ingreso = ?, saldo_inicial = ?, ingreso_proximo = 0 WHERE id = 1")
          .run(destino, ingresoNuevo, saldoNuevo);
        /* Los fijos del mes siguiente se pagan a fin de mes: sus marcas viajan con el usuario. */
        if (!conservar) db.query("UPDATE expenses SET pagado = 0").run();
      })();
      bumpRev();

      const L = [];
      L.push(`${yaEstaba ? "Volví a cerrar" : "Cerré"} ${actual} y ahora estás en ${destino}.`);
      L.push(`  ${actual} guardado en el historial: ingreso ${q(r.ingreso)}, gastos fijos ${q(r.totalGastos)}`
        + `${conservar ? "" : ` (${r.pagados} de ellos pagados)`},`
        + ` pagado a tarjetas ${q(r.pagadoTarjetasMes)}, deuda final ${q(r.deudaActual)}`);
      L.push(`  ${destino} arranca con: ingreso ${q(ingresoNuevo)}`
        + `${ingreso === undefined && num(st.ingresoProximo) > 0 ? " (el esperado que tenías anotado)" : ""}`
        + ` y arrastre ${q(saldoNuevo)}${saldo_inicial === undefined ? " (calculado)" : ""}`);
      if (conservar && r.pagados > 0)
        L.push(`  Ese arrastre incluye lo que ya adelantaste a los fijos de ${destino};`
          + ` allá se te descuentan completos, así que no se pierde ni se cuenta dos veces.`);
      if (conservar && r.pagados > 0)
        L.push(`  Los ${r.pagados} gastos fijos que ya habías marcado pasaron a ${destino} TAMBIÉN marcados`
          + ` (los pagaste adelantados). ${actual} no los reclama como suyos.`);
      else
        L.push(`  Los gastos fijos de ${destino} arrancan sin marcar.`);
      L.push(`  Los previstos y los gastos variables de ${actual} se quedaron en ${actual}.`);
      if (saldoNuevo < 0) L.push(`  Ojo: el cálculo da saldo negativo, o sea que salió más efectivo del que entró.`
        + ` Si no es así, corrígelo con 'fijar_saldo_inicial'.`);
      L.push(`  Ahora anota el ingreso esperado del mes que viene con 'fijar_ingreso_proximo'.`);
      return L.join("\n");
    },
  },
  {
    name: "ver_historial",
    description: "Lista los meses ya cerrados con sus números, o muestra el detalle completo de uno si le pasas el mes.",
    inputSchema: { type: "object", properties: { mes: { type: "string" } }, additionalProperties: false },
    run: ({ mes }) => {
      const filas = db.query("SELECT mes, cerrado_en, datos FROM closed_months ORDER BY cerrado_en").all();
      if (!filas.length) return "Todavía no has cerrado ningún mes.";
      if (!mes) {
        return filas.map(f => {
          const r = JSON.parse(f.datos).resumen;
          return `${f.mes}  ingreso ${q(r.ingreso)} · fijos ${q(r.fijos)} · pagado a tarjetas ${q(r.pagadoTarjetas)}`
            + ` · gasto variable ${q(r.gastadoVariable)} · deuda ${q(r.deudaInicial)} → ${q(r.deudaFinal)}`;
        }).join("\n");
      }
      const f = filas.find(x => x.mes.toLowerCase() === String(mes).toLowerCase())
        || filas.find(x => x.mes.toLowerCase().includes(String(mes).toLowerCase()));
      if (!f) throw new Error(`No hay ningún mes cerrado que coincida con "${mes}".`);
      return `${f.mes} (cerrado el ${f.cerrado_en.slice(0, 10)})\n` + JSON.stringify(JSON.parse(f.datos), null, 2);
    },
  },
  {
    name: "agregar_mes",
    description: "Agrega un mes nuevo a la lista, para poder anotar saldos de tarjetas y gastos en él.",
    inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
    run: ({ label }) => {
      const pos = db.query("SELECT COALESCE(MAX(pos),-1)+1 AS p FROM months").get().p;
      const id = uid() + "m";
      db.query("INSERT INTO months(id,label,pos) VALUES(?,?,?)").run(id, String(label), pos);
      bumpRev(); return `Mes agregado: ${label} (id ${id})`;
    },
  },
];

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

async function mcp(body) {
  const { id, method, params } = body || {};
  const ok = result => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    const pedida = params?.protocolVersion;
    return {
      reply: ok({
        protocolVersion: PROTOCOLS.includes(pedida) ? pedida : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cofre", version: VERSION, title: "Cofre" },
        instructions: "Gastos fijos, suscripciones (GTQ o USD), presupuestos por categoría, metas de ahorro "
          + "y deuda de tarjetas. Empieza con 'estado' para ver todo y la cascada del mes. "
          + "La acción de cada mes es 'anotar_tarjeta'. Durante el mes, 'registrar_gasto' descuenta del "
          + "presupuesto de la categoría y 'aportar_meta' suma a una meta de ahorro.",
      }),
      session: randomBytes(16).toString("hex"),
    };
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) return { reply: null };
  if (method === "ping") return { reply: ok({}) };
  if (method === "tools/list")
    return { reply: ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }) };
  if (method === "tools/call") {
    const t = TOOLS.find(x => x.name === params?.name);
    if (!t) return { reply: err(-32602, `No existe la herramienta "${params?.name}".`) };
    try {
      const texto = await t.run(params?.arguments || {});
      return { reply: ok({ content: [{ type: "text", text: String(texto) }], isError: false }) };
    } catch (e) {
      return { reply: ok({ content: [{ type: "text", text: "Error: " + e.message }], isError: true }) };
    }
  }
  return { reply: err(-32601, `Método no soportado: ${method}`) };
}

/* ───────────────────────────── chat ───────────────────────────── */
const SISTEMA_CHAT = `Eres el asistente financiero de este hogar. Conoces sus números al detalle y
respondes como un asesor de confianza: claro, concreto, sin relleno.

REGLAS
- Nunca inventes cifras. Si te falta un dato, dilo y pide exactamente lo que hace falta.
- Arriba tienes una foto del estado actual ya consultada. Para más detalle (historial, movimientos,
  saldos por mes) usa las herramientas.
- Puedes modificar datos: marcar pagos, anotar gastos, presupuestar, aportar a metas, fijar límites
  y cerrar el mes. NO puedes borrar: si te lo piden, diles que lo hagan en la app.

CÓMO RESPONDER
Primero la respuesta, después el porqué. Estructura:
1. La respuesta directa en una línea, con el número en negritas.
2. Los dos o tres datos que la sostienen, cada uno con su monto.
3. Una recomendación concreta: una sola, con el número que la respalda.
- Cifras en quetzales con formato Q12,345.67. Si conviertes dólares, di el tipo de cambio que usaste.
- Máximo 8 líneas, salvo que pidan un análisis a fondo.
- Habla de tu y de ti, nunca de el usuario.
- Si detectas un riesgo (se va a pasar, cuentas sin pagar, la deuda no baja, una meta estancada),
  dilo de frente y propón qué hacer. Sin sermones.
- Cuando cambies algo, di exactamente qué cambiaste y cómo quedaron los números.

EL MODELO DEL QUE HABLAS
- Cada gasto tiene un medio de pago: efectivo o tarjeta. Lo que se carga a la tarjeta no sale del
  efectivo del mes: se acumula y se paga el mes siguiente.
- Cascada de efectivo: ingreso más arrastre, menos gastos fijos en efectivo, menos suscripciones en
  efectivo, igual a disponible del mes. Menos presupuestos por categoría y aportes a metas, igual a
  libre para asignar.
- Ciclo de la tarjeta: la deuda que traes, más lo cargado este mes, más los previstos, igual a la
  deuda que pagarás el próximo mes.
- Margen: ingreso esperado del próximo mes, menos esa deuda, menos los fijos que pagarás en efectivo,
  menos presupuestos y metas, igual a lo que puedes gastar todavía con la tarjeta.
- El presupuesto de una categoría es dinero apartado, no necesariamente gastado. El medio de pago lo
  define la categoría, no cada gasto suelto.
- Cerrar el mes: congela ese mes en el historial, arrastra el efectivo que sobró y pasa el ingreso
  esperado a ser el ingreso del mes. Los fijos marcados viajan al mes nuevo también marcados, porque
  en esta casa los fijos del mes siguiente se pagan a fin de mes.

LA APP, PARA QUE LA EXPLIQUES
- Chat: aquí, la pantalla de inicio.
- Mes: ingreso, arrastre, la cascada, los gastos fijos, las suscripciones, el cierre de mes y el historial.
- Gastos: presupuestos por categoría y el registro del día a día.
- Metas: ahorros con objetivo y aporte mensual.
- Límite: cuánto puedes cargar a la tarjeta este mes sin pasarte, y los gastos previstos.
- Tarjetas: la deuda, los saldos al cerrar cada mes y cuántos meses te tomaría liquidarla.
- Ajustes (el engranaje arriba a la derecha): tema claro u oscuro, tipo de cambio, respaldo y sesión.`;

const TOOLS_CHAT = TOOLS.filter(t => !/^(eliminar|borrar)/.test(t.name))
  .map(({ name, description, inputSchema }) => ({ type: "function", function: { name, description, parameters: inputSchema } }));

const SOLO_LECTURA = ["estado", "resumen"];

/* Pide al modelo en modo streaming para que el texto vaya apareciendo. */
async function pedir(mensajes, tope, onTrozo) {
  const r = await fetch(`${LLM_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages: mensajes, tools: TOOLS_CHAT,
      tool_choice: "auto", max_tokens: tope, stream: true }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`El modelo respondió ${r.status}`);
  if (!r.body) throw new Error("respuesta vacía del modelo");

  const lector = r.body.getReader(), dec = new TextDecoder();
  let buf = "", texto = "", fin = null;
  const llamadas = [];
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lineas = buf.split("\n");
    buf = lineas.pop() || "";
    for (const linea of lineas) {
      if (!linea.startsWith("data: ")) continue;
      const carga = linea.slice(6).trim();
      if (carga === "[DONE]" || !carga) continue;
      let j; try { j = JSON.parse(carga); } catch { continue; }
      const el = j.choices?.[0];
      if (el?.finish_reason) fin = el.finish_reason;
      const d = el?.delta;
      if (!d) continue;
      if (d.content) { texto += d.content; onTrozo?.(d.content); }
      for (const tc of (d.tool_calls || [])) {
        const i = tc.index ?? 0;
        llamadas[i] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (tc.id) llamadas[i].id = tc.id;
        if (tc.function?.name) llamadas[i].function.name += tc.function.name;
        if (tc.function?.arguments) llamadas[i].function.arguments += tc.function.arguments;
      }
    }
  }
  return { content: texto, tool_calls: llamadas.filter(Boolean), finish_reason: fin };
}

async function resolverChat(historial, aviso, onTrozo) {
  /* El estado actual va en el prompt: así la mayoría de preguntas se responden
     sin ida y vuelta de herramientas, que es lo que las hacía lentas. */
  const mensajes = [{ role: "system", content: SISTEMA_CHAT
    + "\n\nESTADO ACTUAL, ya consultado (no hace falta pedirlo otra vez):\n" + textoEstado() },
    ...historial];
  const usadas = [];
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    let c = await pedir(mensajes, 4000, onTrozo);
    // el modelo razona antes de responder y el razonamiento consume el presupuesto:
    // si se quedó sin espacio y no dijo nada, se reintenta con más
    if (c.finish_reason === "length" && !(c.message.content || "").trim()
        && !(c.message.tool_calls || []).length) {
      c = await pedir(mensajes, 12000, onTrozo);
    }
    const m = c;
    const llamadas = m.tool_calls || [];
    mensajes.push({ role: "assistant", content: m.content ?? null,
      ...(llamadas.length ? { tool_calls: llamadas } : {}) });
    if (!llamadas.length) {
      const texto = (m.content || "").trim();
      if (!texto) throw new Error("El modelo no devolvió texto (se quedó sin espacio). Intenta de nuevo.");
      return { texto, usadas };
    }
    for (const c of llamadas) {
      const nombre = c.function?.name;
      const t = TOOLS.find(x => x.name === nombre);
      aviso?.({ t: "herramienta", nombre });
      let salida;
      try {
        const args = JSON.parse(c.function?.arguments || "{}");
        salida = t ? await t.run(args) : `No existe la herramienta "${nombre}".`;
        if (t && !SOLO_LECTURA.includes(nombre)) usadas.push(nombre);
      } catch (e) {
        salida = "Error: " + e.message;
      }
      mensajes.push({ role: "tool", tool_call_id: c.id, content: String(salida).slice(0, 6000) });
    }
  }
  return { texto: "Me quedé dando vueltas con las herramientas sin cerrar la respuesta. Intenta de nuevo.", usadas };
}

/* ───────────────────────────── auth ───────────────────────────── */
const sha = s => createHash("sha256").update(String(s)).digest("hex");
const igual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
function tokenValido(req) {
  const h = req.headers.get("authorization") || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  const cookie = (req.headers.get("cookie") || "").split(";")
    .map(s => s.trim()).find(s => s.startsWith(COOKIE + "="));
  const tk = bearer || (cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : "");
  if (!tk) return false;
  if (API_TOKEN && igual(tk, API_TOKEN)) return true;
  const s = db.query("SELECT expires_at FROM sessions WHERE token_hash = ?").get(sha(tk));
  if (!s) return false;
  if (s.expires_at < Date.now()) { db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha(tk)); return false; }
  return true;
}
const json = (data, status = 200, headers = {}) => new Response(
  JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } }
);

/* ───────────────────────────── HTTP ───────────────────────────── */
Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") return json({ ok: true, rev: rev(), version: VERSION });

    if (path === "/api/login" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!igual(sha(body?.password ?? ""), sha(APP_PASSWORD))) {
        await Bun.sleep(400);
        return json({ error: "Contraseña incorrecta." }, 401);
      }
      const token = randomBytes(32).toString("base64url");
      db.query("INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,?,?)")
        .run(sha(token), Date.now(), Date.now() + SESSION_DAYS * 864e5);
      db.query("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
      return json({ ok: true }, 200, {
        "set-cookie": `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_DAYS * 86400}`,
      });
    }
    if (path === "/api/logout" && req.method === "POST") {
      const h = req.headers.get("authorization") || "";
      const bearer = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
      if (bearer) db.query("DELETE FROM sessions WHERE token_hash = ?").run(sha(bearer));
      return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; Max-Age=0` });
    }

    if (path === "/mcp") {
      if (req.method !== "POST") return json({ error: "Usa POST en /mcp" }, 405, { allow: "POST" });
      if (!tokenValido(req)) return json({ error: "no autorizado" }, 401);
      const body = await req.json().catch(() => null);
      if (!body) return json({ error: "JSON inválido" }, 400);
      if (Array.isArray(body)) return json({ error: "no soporto lotes" }, 400);
      const { reply, session } = await mcp(body);
      if (!reply) return new Response(null, { status: 202 });
      return json(reply, 200, session ? { "mcp-session-id": session } : {});
    }

    if (path.startsWith("/api/")) {
      if (!tokenValido(req)) return json({ error: "no autorizado" }, 401);
      if (path === "/api/state" && req.method === "GET")
        return json({ rev: rev(), state: readState(), version: VERSION });
      if (path === "/api/state" && req.method === "PUT") {
        const body = await req.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ error: "cuerpo inválido" }, 400);
        if (Number(body.rev) !== rev())
          return json({ error: "conflicto", rev: rev(), state: readState() }, 409);
        return json({ ok: true, rev: writeState(normalizar(body.state)) });
      }
      if (path === "/api/chat" && req.method === "POST") {
        if (!LLM_KEY) return json({ error: "Falta CMD_API_KEY en el servidor." }, 503);
        const body = await req.json().catch(() => null);
        const historial = (Array.isArray(body?.messages) ? body.messages : [])
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .slice(-16)
          .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
        if (!historial.length) return json({ error: "sin mensajes" }, 400);
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(c) {
            const manda = o => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            try {
              const { texto, usadas } = await resolverChat(historial, ev => manda(ev),
                trozo => manda({ t: "trozo", v: trozo }));
              manda({ t: "texto", v: texto });
              manda({ t: "fin", usadas, rev: rev() });
            } catch (e) {
              manda({ t: "error", v: e.message || "falló el modelo" });
            }
            c.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream; charset=utf-8",
                     "cache-control": "no-store", "x-accel-buffering": "no" },
        });
      }
      if (path === "/api/resumen" && req.method === "GET") return json(calcResumen());
      if (path === "/api/cerrar-mes" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const t = TOOLS.find(x => x.name === "cerrar_mes");
        try {
          const mensaje = await t.run({ confirmar: true, mes: body.mes,
            saldo_inicial: body.saldoInicial, ingreso: body.ingreso,
            conservar_pagados: body.conservarPagados });
          return json({ ok: true, mensaje, rev: rev(), state: readState() });
        } catch (e) {
          return json({ error: e.message }, 400);
        }
      }
      if (path === "/api/tipo-cambio" && req.method === "GET") {
        try {
          const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) });
          const d = await r.json();
          const v = num(d?.rates?.GTQ, null);
          if (v === null) throw new Error("sin dato");
          return json({ ok: true, gtqPorUsd: v, fecha: d.time_last_update_utc });
        } catch {
          return json({ error: "No pude consultar el tipo de cambio." }, 502);
        }
      }
      return json({ error: "no existe" }, 404);
    }

    const rel = path === "/" ? "/index.html" : path;
    const file = Bun.file(join(PUBLIC_DIR, rel.replace(/\.\./g, "")));
    if (await file.exists())
      return new Response(file, {
        headers: { "cache-control": rel === "/index.html" ? "no-cache" : "public, max-age=3600" },
      });
    return new Response("No encontrado", { status: 404 });
  },
});

console.log(`Cofre v${VERSION} en :${PORT}  ·  db ${DB_PATH}  ·  rev ${rev()}`);

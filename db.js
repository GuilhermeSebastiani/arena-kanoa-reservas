// Camada de banco: Postgres em produção (DATABASE_URL), SQLite embutido para testes locais.
// SQL escrito com $1, $2... e tipos simples (TEXT/INTEGER/REAL) para funcionar nos dois.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS reservas (
    id TEXT PRIMARY KEY,
    tipo TEXT NOT NULL,            -- quadra | evento | bloqueio
    data TEXT NOT NULL,            -- YYYY-MM-DD
    inicio TEXT,                   -- HH:MM
    fim TEXT,                      -- HH:MM
    quadras INTEGER DEFAULT 0,
    espaco TEXT,                   -- arena | quiosque (eventos)
    resp TEXT,
    telefone TEXT,
    email TEXT,
    valor REAL DEFAULT 0,          -- valor total da reserva
    valor_pix REAL DEFAULT 0,      -- valor cobrado no PIX (sinal ou total)
    status TEXT NOT NULL,          -- pendente | confirmada | cancelada | expirada | conflito
    origem TEXT DEFAULT 'site',    -- site | admin
    mp_payment_id TEXT,
    pix_copia TEXT,
    pix_qr TEXT,
    expira_em TEXT,
    pago_em TEXT,
    checado_em TEXT,
    obs TEXT,
    criado TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS reservas_data ON reservas (data)`,
  `CREATE TABLE IF NOT EXISTS usuarios (
    id TEXT PRIMARY KEY,
    login TEXT UNIQUE NOT NULL,
    nome TEXT,
    hash TEXT NOT NULL,
    criado TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  )`,
];

async function open() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
    const db = {
      kind: 'pg',
      async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
      async get(sql, params = []) { return (await pool.query(sql, params)).rows[0]; },
      async run(sql, params = []) { const r = await pool.query(sql, params); return { changes: r.rowCount }; },
    };
    for (const s of SCHEMA) await db.run(s);
    await db.run('ALTER TABLE reservas ADD COLUMN IF NOT EXISTS quadras_num TEXT');
    return db;
  }
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_FILE || ':memory:';
  const s = new DatabaseSync(file);
  const conv = (sql) => sql.replace(/\$\d+/g, '?');
  const db = {
    kind: 'sqlite',
    async all(sql, params = []) { return s.prepare(conv(sql)).all(...params); },
    async get(sql, params = []) { return s.prepare(conv(sql)).get(...params); },
    async run(sql, params = []) { const r = s.prepare(conv(sql)).run(...params); return { changes: r.changes }; },
  };
  for (const q of SCHEMA) s.exec(q);
  try { s.exec('ALTER TABLE reservas ADD COLUMN quadras_num TEXT'); } catch {}
  return db;
}

module.exports = { open };

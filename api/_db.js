const { Pool } = require("pg");

let pool;

// Tuned for serverless: each function invocation can land on a fresh instance with its
// own pool, and DATABASE_URL already points at Neon's pgbouncer endpoint (transaction
// pooling, thousands of client slots) — so a small per-instance pool is enough, and we'd
// rather fail fast than let a request hang past Vercel's own function timeout.
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      query_timeout: 8000,
    });
    // Without this, a dropped idle connection (Neon scaling to zero, network blip)
    // would crash the whole process on the next tick instead of just failing the
    // one query that happens to hit it.
    pool.on("error", (err) => {
      console.error("Erro inesperado no pool do Postgres:", err);
    });
  }
  return pool;
}

module.exports = { getPool };

// One-off/idempotent migration runner. Reads DATABASE_URL from .env (this project
// has no dotenv dependency, so we parse the file by hand) and applies db/schema.sql,
// then seeds the `provas` table on first run only.
//
// Usage: node db/migrate.js

const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) return;
    const key = m[1];
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
}

loadEnvFile();

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL não definido (verifique o arquivo .env).");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  console.log("Schema aplicado (schools, provas, jurados, pontuacoes, pontuacoes_log, configuracao).");

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM provas");
  if (rows[0].n === 0) {
    const provas = require("./provas-seed");
    for (const p of provas) {
      await pool.query(
        "INSERT INTO provas (numero, ordem, nome, pontuacao_maxima, regras) VALUES ($1, $2, $3, $4, $5)",
        [p.numero, p.ordem, p.nome, p.pontuacao_maxima, p.regras]
      );
    }
    console.log(`Seed: ${provas.length} provas inseridas.`);
  } else {
    console.log(`Tabela provas já tem ${rows[0].n} registro(s), seed ignorado.`);
  }

  const legacy = await pool
    .query("SELECT COUNT(*)::int AS n FROM escolas")
    .catch(() => null);
  if (legacy && legacy.rows[0].n > 0) {
    console.log(
      `Aviso: a tabela antiga "escolas" ainda tem ${legacy.rows[0].n} lançamento(s) do sistema anterior. ` +
        "Ela não é mais usada pelo novo painel, mas os dados continuam no banco caso precise consultar."
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

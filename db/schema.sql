-- Gincana Estadual da Juventude 2026 — schema
-- Applied idempotently by db/migrate.js. Kept here for reference/version control
-- (the live database has no other source of truth for this schema).

CREATE TABLE IF NOT EXISTS schools (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  municipio  TEXT,
  ativo      BOOLEAN NOT NULL DEFAULT true,
  criado_em  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provas (
  id                SERIAL PRIMARY KEY,
  numero            TEXT NOT NULL,
  ordem             INTEGER NOT NULL,
  nome              TEXT NOT NULL,
  pontuacao_maxima  NUMERIC NOT NULL,
  regras            TEXT,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  criado_em         TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jurados (
  id         SERIAL PRIMARY KEY,
  nome       TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  ativo      BOOLEAN NOT NULL DEFAULT true,
  criado_em  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pontuacoes (
  id             SERIAL PRIMARY KEY,
  jurado_id      INTEGER NOT NULL REFERENCES jurados(id) ON DELETE CASCADE,
  escola_id      INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  prova_id       INTEGER NOT NULL REFERENCES provas(id) ON DELETE CASCADE,
  pontos         NUMERIC NOT NULL,
  criado_em      TIMESTAMP NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (jurado_id, escola_id, prova_id)
);

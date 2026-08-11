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

-- Posição da escola no sorteio público de desempate (Art. 53). Nula até o sorteio
-- acontecer; menor número vence quando os critérios de prova terminam empatados.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS ordem_sorteio INTEGER;

-- Dia em que a escola disputa a fase eliminatória (Art. 25, III do Edital): '11' ou
-- '12'. Usada só para ordenar a caixa de seleção do jurado (quem apresenta "hoje"
-- aparece primeiro); no dia 13 (Grande Final) todas as escolas participam juntas.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS dia_apresentacao TEXT;

-- Posição fixa da escola na lista oficial (não é ordem alfabética nem de sorteio).
-- No dia de apresentação dela, as escolas daquele dia aparecem primeiro, nessa ordem;
-- as do outro dia ficam depois, também nessa ordem. No dia 13 (ou qualquer outro dia),
-- usa direto essa mesma sequência, sem separar por dia.
ALTER TABLE schools ADD COLUMN IF NOT EXISTS ordem_apresentacao INTEGER;

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

-- O índice do UNIQUE(jurado_id, escola_id, prova_id) já cobre buscas por jurado_id
-- sozinho (é a coluna líder — usado em "minhas notas"), mas não ajuda o GROUP BY do
-- ranking público, que agrupa por escola_id/prova_id sem jurado_id.
CREATE INDEX IF NOT EXISTS idx_pontuacoes_escola_prova ON pontuacoes (escola_id, prova_id);

-- Trilha de auditoria de lançamentos (Art. 12, § único do Edital): toda criação, edição
-- ou exclusão de nota vira uma linha aqui, mesmo depois que a linha em `pontuacoes` some
-- (jurado_id/escola_id/prova_id não têm FK — precisam sobreviver à exclusão do registro
-- original, do jurado ou da escola/prova).
CREATE TABLE IF NOT EXISTS pontuacoes_log (
  id             SERIAL PRIMARY KEY,
  pontuacao_id   INTEGER,
  jurado_id      INTEGER,
  escola_id      INTEGER NOT NULL,
  prova_id       INTEGER NOT NULL,
  acao           TEXT NOT NULL,
  valor_antigo   NUMERIC,
  valor_novo     NUMERIC,
  autor          TEXT NOT NULL,
  motivo         TEXT,
  criado_em      TIMESTAMP NOT NULL DEFAULT now()
);

-- Estado global da competição: linha única (id fixo em 1).
CREATE TABLE IF NOT EXISTS configuracao (
  id              SMALLINT PRIMARY KEY DEFAULT 1,
  encerrada       BOOLEAN NOT NULL DEFAULT false,
  ranking_oculto  BOOLEAN NOT NULL DEFAULT false,
  atualizado_em   TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT configuracao_singleton CHECK (id = 1)
);
INSERT INTO configuracao (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Trava de força bruta no login do admin (usuário/senha sem mais o link secreto por
-- cima). Chaveada por IP de origem; zera sozinha quando um login correto acontece.
CREATE TABLE IF NOT EXISTS login_tentativas (
  chave           TEXT PRIMARY KEY,
  falhas          INTEGER NOT NULL DEFAULT 0,
  ultima_em       TIMESTAMP NOT NULL DEFAULT now()
);

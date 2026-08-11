// Shared by scores.js (public/jurado) and admin.js: competition state and the
// pontuacoes audit trail (Art. 12, § único do Edital).

async function getConfiguracao(pool) {
  const { rows } = await pool.query(
    "SELECT encerrada, ranking_oculto, senha_padrao_jurado FROM configuracao WHERE id = 1"
  );
  return rows[0] || { encerrada: false, ranking_oculto: false, senha_padrao_jurado: null };
}

async function registrarLog(pool, { pontuacaoId, juradoId, escolaId, provaId, acao, valorAntigo, valorNovo, autor, motivo }) {
  await pool.query(
    `INSERT INTO pontuacoes_log (pontuacao_id, jurado_id, escola_id, prova_id, acao, valor_antigo, valor_novo, autor, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [pontuacaoId ?? null, juradoId ?? null, escolaId, provaId, acao, valorAntigo ?? null, valorNovo ?? null, autor, motivo ?? null]
  );
}

module.exports = { getConfiguracao, registrarLog };

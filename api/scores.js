const { getPool } = require("./_db");
const { getConfiguracao, registrarLog } = require("./_config");

function bad(res, code, erro) {
  return res.status(code).json({ erro });
}

async function getJuradoByToken(pool, token) {
  if (!token || typeof token !== "string") return null;
  const { rows } = await pool.query(
    "SELECT id, nome, ativo FROM jurados WHERE token = $1",
    [token]
  );
  if (!rows.length || !rows[0].ativo) return null;
  return rows[0];
}

// Critérios de desempate sucessivos (Art. 53 do Edital): melhor pontuação, nesta ordem,
// nas provas de nº 1 (Arrecadação Solidária), 2 (Desfile das Escolas), 7 (Quiz "Torta na
// Cara") e 4 (Circuito Recreativo). Persistindo o empate, decide a ordem do sorteio
// público (menor número vence). Isso é sempre calculado — nunca deixado para o
// `ORDER BY` do SQL, que resolveria empates silenciosamente por ordem alfabética.
const CASCATA_DESEMPATE = ["1", "2", "7", "4"];

async function buildRanking(pool) {
  const { rows: provas } = await pool.query(
    "SELECT id, numero, ordem, nome, pontuacao_maxima FROM provas WHERE ativo = true ORDER BY ordem ASC"
  );
  const { rows: schools } = await pool.query(
    "SELECT id, nome, municipio, ordem_sorteio FROM schools WHERE ativo = true ORDER BY nome ASC"
  );
  const { rows: somas } = await pool.query(
    `SELECT pt.escola_id, pt.prova_id, LEAST(SUM(pt.pontos), MIN(p.pontuacao_maxima)) AS pontos
     FROM pontuacoes pt
     JOIN provas p ON p.id = pt.prova_id AND p.ativo = true
     JOIN schools e ON e.id = pt.escola_id AND e.ativo = true
     GROUP BY pt.escola_id, pt.prova_id`
  );

  const porEscola = {};
  somas.forEach((s) => {
    if (!porEscola[s.escola_id]) porEscola[s.escola_id] = {};
    porEscola[s.escola_id][s.prova_id] = Number(s.pontos);
  });

  const provaPorNumero = {};
  provas.forEach((p) => (provaPorNumero[p.numero] = p));

  function criteriosIguais(x, y) {
    if (x.total !== y.total) return false;
    for (const numero of CASCATA_DESEMPATE) {
      const prova = provaPorNumero[numero];
      if (!prova) continue;
      if ((x.porProva[prova.id] || 0) !== (y.porProva[prova.id] || 0)) return false;
    }
    return (x.ordem_sorteio ?? null) === (y.ordem_sorteio ?? null);
  }

  const ranking = schools
    .map((e) => {
      const porProva = porEscola[e.id] || {};
      const total = Object.values(porProva).reduce((a, b) => a + b, 0);
      return {
        id: e.id,
        nome: e.nome,
        municipio: e.municipio,
        ordem_sorteio: e.ordem_sorteio,
        porProva,
        total,
      };
    })
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      for (const numero of CASCATA_DESEMPATE) {
        const prova = provaPorNumero[numero];
        if (!prova) continue;
        const diff = (b.porProva[prova.id] || 0) - (a.porProva[prova.id] || 0);
        if (diff !== 0) return diff;
      }
      const sa = a.ordem_sorteio;
      const sb = b.ordem_sorteio;
      if (sa != null && sb != null && sa !== sb) return sa - sb;
      if (sa != null && sb == null) return -1;
      if (sb != null && sa == null) return 1;
      // Ninguém decidiu: cai para ordem alfabética, mas marcado como `empatada` abaixo
      // em vez de ficar escondido atrás de um sort estável.
      return a.nome.localeCompare(b.nome, "pt-BR");
    });

  ranking.forEach((e, i) => {
    const anterior = ranking[i - 1];
    const proximo = ranking[i + 1];
    e.empatada = Boolean((anterior && criteriosIguais(anterior, e)) || (proximo && criteriosIguais(e, proximo)));
  });

  return { provas, schools: ranking };
}

module.exports = async (req, res) => {
  const pool = getPool();
  const { resource, token } = req.query;

  if (req.method === "GET" && (resource === "ranking" || !resource)) {
    const config = await getConfiguracao(pool);
    if (config.ranking_oculto) {
      return res.status(200).json({ oculto: true });
    }
    const data = await buildRanking(pool);
    return res.status(200).json({ oculto: false, ...data });
  }

  if (req.method === "GET" && resource === "meta") {
    const { rows: provas } = await pool.query(
      "SELECT id, numero, ordem, nome, pontuacao_maxima FROM provas WHERE ativo = true ORDER BY ordem ASC"
    );
    const { rows: schools } = await pool.query(
      "SELECT id, nome, municipio FROM schools WHERE ativo = true ORDER BY nome ASC"
    );
    return res.status(200).json({ provas, schools });
  }

  if (req.method === "GET" && resource === "mine") {
    const jurado = await getJuradoByToken(pool, token);
    if (!jurado) return bad(res, 401, "Link inválido, desativado ou expirado.");

    const { rows: provas } = await pool.query(
      "SELECT id, numero, ordem, nome, pontuacao_maxima FROM provas WHERE ativo = true ORDER BY ordem ASC"
    );
    const { rows: schools } = await pool.query(
      "SELECT id, nome, municipio FROM schools WHERE ativo = true ORDER BY nome ASC"
    );
    const { rows: minhas } = await pool.query(
      "SELECT id, escola_id, prova_id, pontos, atualizado_em FROM pontuacoes WHERE jurado_id = $1",
      [jurado.id]
    );
    const config = await getConfiguracao(pool);

    // Nenhum outro jurado (nem seus tokens) é devolvido aqui: um link vazado só pode
    // agir como o próprio dono do link. A troca de jurado num tablet compartilhado é
    // resolvida inteiramente no cliente, a partir dos links que o próprio dispositivo
    // já abriu — ver jurado.html.
    return res.status(200).json({
      jurado: { id: jurado.id, nome: jurado.nome },
      provas,
      schools,
      minhas,
      encerrada: config.encerrada,
    });
  }

  if (req.method === "POST") {
    const { token: bodyToken, escola_id, prova_id, pontos } = req.body || {};
    const jurado = await getJuradoByToken(pool, bodyToken);
    if (!jurado) return bad(res, 401, "Link inválido, desativado ou expirado.");

    const config = await getConfiguracao(pool);
    if (config.encerrada) {
      return bad(res, 403, "Lançamentos encerrados: a competição já foi homologada.");
    }

    const escolaId = Number(escola_id);
    const provaId = Number(prova_id);
    const pontosNum = Number(pontos);

    if (!Number.isInteger(escolaId)) return bad(res, 400, "Escola inválida.");
    if (!Number.isInteger(provaId)) return bad(res, 400, "Prova inválida.");
    if (!Number.isFinite(pontosNum) || pontosNum < 0) {
      return bad(res, 400, "Pontuação inválida.");
    }

    const { rows: provaRows } = await pool.query(
      "SELECT id, pontuacao_maxima FROM provas WHERE id = $1 AND ativo = true",
      [provaId]
    );
    if (!provaRows.length) return bad(res, 404, "Prova não encontrada.");
    if (pontosNum > Number(provaRows[0].pontuacao_maxima)) {
      return bad(res, 400, `A pontuação não pode passar de ${provaRows[0].pontuacao_maxima} nesta prova.`);
    }

    const { rows: escolaRows } = await pool.query(
      "SELECT id FROM schools WHERE id = $1 AND ativo = true",
      [escolaId]
    );
    if (!escolaRows.length) return bad(res, 404, "Escola não encontrada.");

    const { rows: existentes } = await pool.query(
      "SELECT pontos FROM pontuacoes WHERE jurado_id = $1 AND escola_id = $2 AND prova_id = $3",
      [jurado.id, escolaId, provaId]
    );
    const valorAntigo = existentes.length ? Number(existentes[0].pontos) : null;

    const { rows } = await pool.query(
      `INSERT INTO pontuacoes (jurado_id, escola_id, prova_id, pontos)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (jurado_id, escola_id, prova_id)
       DO UPDATE SET pontos = EXCLUDED.pontos, atualizado_em = now()
       RETURNING id, escola_id, prova_id, pontos, atualizado_em`,
      [jurado.id, escolaId, provaId, pontosNum]
    );

    await registrarLog(pool, {
      pontuacaoId: rows[0].id,
      juradoId: jurado.id,
      escolaId,
      provaId,
      acao: valorAntigo === null ? "criar" : "editar",
      valorAntigo,
      valorNovo: pontosNum,
      autor: jurado.nome,
    });

    return res.status(200).json(rows[0]);
  }

  if (req.method === "DELETE") {
    const jurado = await getJuradoByToken(pool, token);
    if (!jurado) return bad(res, 401, "Link inválido, desativado ou expirado.");

    const config = await getConfiguracao(pool);
    if (config.encerrada) {
      return bad(res, 403, "Lançamentos encerrados: a competição já foi homologada.");
    }

    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");

    const { rows: existentes } = await pool.query(
      "SELECT escola_id, prova_id, pontos FROM pontuacoes WHERE id = $1 AND jurado_id = $2",
      [id, jurado.id]
    );
    if (!existentes.length) return res.status(204).end();

    await pool.query("DELETE FROM pontuacoes WHERE id = $1 AND jurado_id = $2", [id, jurado.id]);

    await registrarLog(pool, {
      pontuacaoId: id,
      juradoId: jurado.id,
      escolaId: existentes[0].escola_id,
      provaId: existentes[0].prova_id,
      acao: "apagar",
      valorAntigo: Number(existentes[0].pontos),
      valorNovo: null,
      autor: jurado.nome,
    });

    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return bad(res, 405, "Método não permitido.");
};

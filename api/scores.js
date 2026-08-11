const { getPool } = require("./_db");
const { getConfiguracao, registrarLog } = require("./_config");
const { safeEqual } = require("./_auth");

function bad(res, code, erro) {
  return res.status(code).json({ erro });
}

// Jurados comuns: senha = a senha padrão única (configuracao.senha_padrao_jurado).
// Jurado mestre: senha própria (jurados.senha). Nenhum dos dois é exposto a quem não
// souber a senha certa — só saber o token (nome) não basta mais.
async function autenticarJurado(pool, token, senha) {
  if (!token || typeof token !== "string" || !senha || typeof senha !== "string") return null;
  const { rows } = await pool.query(
    "SELECT id, nome, ativo, mestre, senha FROM jurados WHERE token = $1",
    [token]
  );
  if (!rows.length || !rows[0].ativo) return null;
  const jurado = rows[0];

  const senhaEsperada = jurado.mestre
    ? jurado.senha
    : (await getConfiguracao(pool)).senha_padrao_jurado;

  if (!senhaEsperada || !safeEqual(senha, senhaEsperada)) return null;
  return jurado;
}

// Resolve em nome de qual jurado a ação será registrada: o próprio autenticado, ou —
// só se ele for mestre — outro jurado comum indicado por `alvoId` (o mestre "assume" a
// conta sem precisar da senha da pessoa).
async function resolverAlvo(pool, autenticado, alvoId) {
  if (alvoId === undefined || alvoId === null || alvoId === "") return autenticado;
  if (!autenticado.mestre) return null;
  const id = Number(alvoId);
  if (!Number.isInteger(id)) return null;
  const { rows } = await pool.query(
    "SELECT id, nome, ativo FROM jurados WHERE id = $1 AND ativo = true AND mestre = false",
    [id]
  );
  return rows.length ? rows[0] : null;
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
    "SELECT id, nome, municipio, ordem_sorteio, cor_turma FROM schools WHERE ativo = true ORDER BY nome ASC"
  );
  const { rows: somas } = await pool.query(
    `SELECT pt.escola_id, pt.prova_id, SUM(pt.pontos) AS pontos
     FROM pontuacoes pt
     JOIN provas p ON p.id = pt.prova_id AND p.ativo = true
     JOIN schools e ON e.id = pt.escola_id AND e.ativo = true
     GROUP BY pt.escola_id, pt.prova_id`
  );
  const { rows: penalidades } = await pool.query(
    `SELECT pa.escola_id, SUM(pa.valor) AS valor
     FROM penalidades_admin pa
     JOIN schools e ON e.id = pa.escola_id AND e.ativo = true
     GROUP BY pa.escola_id`
  );

  const porEscola = {};
  somas.forEach((s) => {
    if (!porEscola[s.escola_id]) porEscola[s.escola_id] = {};
    porEscola[s.escola_id][s.prova_id] = Number(s.pontos);
  });

  // Penalidade do admin: desconta do total geral, não de nenhuma prova específica
  // (por isso não entra em porProva, só no total abaixo).
  const penalidadePorEscola = {};
  penalidades.forEach((p) => { penalidadePorEscola[p.escola_id] = Number(p.valor); });

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
      const total = Object.values(porProva).reduce((a, b) => a + b, 0) - (penalidadePorEscola[e.id] || 0);
      return {
        id: e.id,
        nome: e.nome,
        municipio: e.municipio,
        ordem_sorteio: e.ordem_sorteio,
        cor_turma: e.cor_turma,
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
 try {
  const pool = getPool();
  const { resource, token } = req.query;

  if (req.method === "GET" && (resource === "ranking" || !resource)) {
    const config = await getConfiguracao(pool);
    // Página pública, atualiza sozinha a cada 20s e pode ter muita gente com a aba
    // aberta ao mesmo tempo (torcida, cerimônia). Cachear por alguns segundos na CDN
    // da Vercel poupa banco e invocações de função sob rajada, sem atrasar de forma
    // perceptível a revelação do resultado (Momento 3) além do próprio polling de 20s.
    res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=15");
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
      "SELECT id, nome, municipio, dia_apresentacao, ordem_apresentacao, cor_turma FROM schools WHERE ativo = true ORDER BY nome ASC"
    );
    return res.status(200).json({ provas, schools });
  }

  if (req.method === "GET" && resource === "mine") {
    const autenticado = await autenticarJurado(pool, token, req.query.senha);
    if (!autenticado) return bad(res, 401, "Link ou senha inválidos.");

    // "como" só tem efeito se quem autenticou for o jurado mestre: deixa ver/lançar
    // notas em nome de outro jurado sem saber a senha dele.
    const alvo = await resolverAlvo(pool, autenticado, req.query.como);
    if (!alvo) return bad(res, 400, "Jurado alvo inválido.");

    const { rows: provas } = await pool.query(
      "SELECT id, numero, ordem, nome, pontuacao_maxima FROM provas WHERE ativo = true ORDER BY ordem ASC"
    );
    const { rows: schools } = await pool.query(
      "SELECT id, nome, municipio, dia_apresentacao, ordem_apresentacao FROM schools WHERE ativo = true ORDER BY nome ASC"
    );
    const { rows: minhas } = await pool.query(
      "SELECT id, escola_id, prova_id, pontos, penalidade, atualizado_em FROM pontuacoes WHERE jurado_id = $1",
      [alvo.id]
    );
    const config = await getConfiguracao(pool);

    const resposta = {
      jurado: { id: alvo.id, nome: alvo.nome },
      mestre: Boolean(autenticado.mestre),
      provas,
      schools,
      minhas,
      encerrada: config.encerrada,
    };

    // Roster só sai para o mestre, e só com id/nome (sem token/senha de ninguém) —
    // é usado apenas para montar a lista de "atuar como", nunca para autenticação.
    if (autenticado.mestre) {
      const { rows: todos } = await pool.query(
        "SELECT id, nome FROM jurados WHERE ativo = true AND mestre = false ORDER BY nome ASC"
      );
      resposta.jurados = todos;
    }

    return res.status(200).json(resposta);
  }

  if (req.method === "POST") {
    const { token: bodyToken, senha, jurado_id, escola_id, prova_id, pontos, penalidade } = req.body || {};
    const autenticado = await autenticarJurado(pool, bodyToken, senha);
    if (!autenticado) return bad(res, 401, "Link ou senha inválidos.");
    const alvo = await resolverAlvo(pool, autenticado, jurado_id);
    if (!alvo) return bad(res, 400, "Jurado alvo inválido.");

    const config = await getConfiguracao(pool);
    if (config.encerrada) {
      return bad(res, 403, "Lançamentos encerrados: a competição já foi homologada.");
    }

    const escolaId = Number(escola_id);
    const provaId = Number(prova_id);
    const pontosNum = Number(pontos);
    const penalidadeVal = penalidade ? String(penalidade).trim().slice(0, 200) : null;

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
      [alvo.id, escolaId, provaId]
    );
    const valorAntigo = existentes.length ? Number(existentes[0].pontos) : null;

    const { rows } = await pool.query(
      `INSERT INTO pontuacoes (jurado_id, escola_id, prova_id, pontos, penalidade)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (jurado_id, escola_id, prova_id)
       DO UPDATE SET pontos = EXCLUDED.pontos, penalidade = EXCLUDED.penalidade, atualizado_em = now()
       RETURNING id, escola_id, prova_id, pontos, penalidade, atualizado_em`,
      [alvo.id, escolaId, provaId, pontosNum, penalidadeVal]
    );

    await registrarLog(pool, {
      pontuacaoId: rows[0].id,
      juradoId: alvo.id,
      escolaId,
      provaId,
      acao: valorAntigo === null ? "criar" : "editar",
      valorAntigo,
      valorNovo: pontosNum,
      autor: autenticado.mestre && autenticado.id !== alvo.id ? `${alvo.nome} (via mestre ${autenticado.nome})` : alvo.nome,
    });

    return res.status(200).json(rows[0]);
  }

  if (req.method === "DELETE") {
    const autenticado = await autenticarJurado(pool, token, req.query.senha);
    if (!autenticado) return bad(res, 401, "Link ou senha inválidos.");
    const alvo = await resolverAlvo(pool, autenticado, req.query.jurado_id);
    if (!alvo) return bad(res, 400, "Jurado alvo inválido.");

    const config = await getConfiguracao(pool);
    if (config.encerrada) {
      return bad(res, 403, "Lançamentos encerrados: a competição já foi homologada.");
    }

    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");

    const { rows: existentes } = await pool.query(
      "SELECT escola_id, prova_id, pontos FROM pontuacoes WHERE id = $1 AND jurado_id = $2",
      [id, alvo.id]
    );
    if (!existentes.length) return res.status(204).end();

    await pool.query("DELETE FROM pontuacoes WHERE id = $1 AND jurado_id = $2", [id, alvo.id]);

    await registrarLog(pool, {
      pontuacaoId: id,
      juradoId: alvo.id,
      escolaId: existentes[0].escola_id,
      provaId: existentes[0].prova_id,
      acao: "apagar",
      valorAntigo: Number(existentes[0].pontos),
      valorNovo: null,
      autor: autenticado.mestre && autenticado.id !== alvo.id ? `${alvo.nome} (via mestre ${autenticado.nome})` : alvo.nome,
    });

    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return bad(res, 405, "Método não permitido.");
 } catch (err) {
  console.error("Erro em /api/scores:", err);
  if (!res.headersSent) return bad(res, 500, "Erro interno. Tente novamente em instantes.");
 }
};

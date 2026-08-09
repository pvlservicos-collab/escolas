const { getPool } = require("./_db");

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

async function buildRanking(pool) {
  const { rows: provas } = await pool.query(
    "SELECT id, numero, ordem, nome, pontuacao_maxima FROM provas WHERE ativo = true ORDER BY ordem ASC"
  );
  const { rows: schools } = await pool.query(
    "SELECT id, nome, municipio FROM schools WHERE ativo = true ORDER BY nome ASC"
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

  const ranking = schools
    .map((e) => {
      const porProva = porEscola[e.id] || {};
      const total = Object.values(porProva).reduce((a, b) => a + b, 0);
      return { id: e.id, nome: e.nome, municipio: e.municipio, porProva, total };
    })
    .sort((a, b) => b.total - a.total);

  return { provas, schools: ranking };
}

module.exports = async (req, res) => {
  const pool = getPool();
  const { resource, token } = req.query;

  if (req.method === "GET" && (resource === "ranking" || !resource)) {
    const data = await buildRanking(pool);
    return res.status(200).json(data);
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

    // Nenhum outro jurado (nem seus tokens) é devolvido aqui: um link vazado só pode
    // agir como o próprio dono do link. A troca de jurado num tablet compartilhado é
    // resolvida inteiramente no cliente, a partir dos links que o próprio dispositivo
    // já abriu — ver jurado.html.
    return res.status(200).json({ jurado: { id: jurado.id, nome: jurado.nome }, provas, schools, minhas });
  }

  if (req.method === "POST") {
    const { token: bodyToken, escola_id, prova_id, pontos } = req.body || {};
    const jurado = await getJuradoByToken(pool, bodyToken);
    if (!jurado) return bad(res, 401, "Link inválido, desativado ou expirado.");

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

    const { rows } = await pool.query(
      `INSERT INTO pontuacoes (jurado_id, escola_id, prova_id, pontos)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (jurado_id, escola_id, prova_id)
       DO UPDATE SET pontos = EXCLUDED.pontos, atualizado_em = now()
       RETURNING id, escola_id, prova_id, pontos, atualizado_em`,
      [jurado.id, escolaId, provaId, pontosNum]
    );
    return res.status(200).json(rows[0]);
  }

  if (req.method === "DELETE") {
    const jurado = await getJuradoByToken(pool, token);
    if (!jurado) return bad(res, 401, "Link inválido, desativado ou expirado.");
    const id = Number(req.query.id);
    if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
    await pool.query("DELETE FROM pontuacoes WHERE id = $1 AND jurado_id = $2", [id, jurado.id]);
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return bad(res, 405, "Método não permitido.");
};

const { getPool } = require("./_db");
const {
  signSession,
  requireAdminKey,
  requireAdminSession,
  safeEqual,
  newToken,
} = require("./_auth");

function bad(res, code, erro) {
  return res.status(code).json({ erro });
}

module.exports = async (req, res) => {
  const pool = getPool();
  const { resource } = req.query;
  const id = req.query.id !== undefined ? Number(req.query.id) : undefined;

  // ---- unauthenticated: only tells the front-end whether the secret link is valid ----
  if (resource === "check-key") {
    if (req.method !== "GET") return bad(res, 405, "Método não permitido.");
    return res.status(200).json({ ok: requireAdminKey(req) });
  }

  // Every other action requires the secret-link key on the header.
  if (!requireAdminKey(req)) {
    return bad(res, 404, "Não encontrado.");
  }

  if (resource === "login") {
    if (req.method !== "POST") return bad(res, 405, "Método não permitido.");
    const { usuario, senha } = req.body || {};
    const okUser =
      typeof usuario === "string" && safeEqual(usuario, process.env.ADMIN_USERNAME || "");
    const okPass =
      typeof senha === "string" && safeEqual(senha, process.env.ADMIN_PASSWORD || "");
    if (!okUser || !okPass) return bad(res, 401, "Usuário ou senha inválidos.");
    return res.status(200).json({ token: signSession(usuario) });
  }

  // Everything below requires a valid logged-in session too.
  const session = requireAdminSession(req);
  if (!session) return bad(res, 401, "Sessão inválida ou expirada. Faça login novamente.");

  if (resource === "schools") {
    if (req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT id, nome, municipio, ativo FROM schools ORDER BY nome ASC"
      );
      return res.status(200).json(rows);
    }
    if (req.method === "POST") {
      const { nome, municipio } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      const { rows } = await pool.query(
        "INSERT INTO schools (nome, municipio) VALUES ($1, $2) RETURNING id, nome, municipio, ativo",
        [String(nome).trim(), municipio ? String(municipio).trim() : null]
      );
      return res.status(201).json(rows[0]);
    }
    if (req.method === "PUT") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      const { nome, municipio, ativo } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      const { rows } = await pool.query(
        "UPDATE schools SET nome = $1, municipio = $2, ativo = $3 WHERE id = $4 RETURNING id, nome, municipio, ativo",
        [String(nome).trim(), municipio ? String(municipio).trim() : null, ativo !== false, id]
      );
      if (!rows.length) return bad(res, 404, "Não encontrado.");
      return res.status(200).json(rows[0]);
    }
    if (req.method === "DELETE") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      await pool.query("DELETE FROM schools WHERE id = $1", [id]);
      return res.status(204).end();
    }
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return bad(res, 405, "Método não permitido.");
  }

  if (resource === "provas") {
    if (req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT id, numero, ordem, nome, pontuacao_maxima, regras, ativo FROM provas ORDER BY ordem ASC"
      );
      return res.status(200).json(rows);
    }
    if (req.method === "POST") {
      const { numero, ordem, nome, pontuacao_maxima, regras } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      const max = Number(pontuacao_maxima);
      if (!Number.isFinite(max) || max <= 0) return bad(res, 400, "Pontuação máxima inválida.");
      const { rows } = await pool.query(
        `INSERT INTO provas (numero, ordem, nome, pontuacao_maxima, regras)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, numero, ordem, nome, pontuacao_maxima, regras, ativo`,
        [
          numero ? String(numero).trim() : String(ordem || ""),
          Number.isFinite(Number(ordem)) ? Number(ordem) : 999,
          String(nome).trim(),
          max,
          regras ? String(regras) : "",
        ]
      );
      return res.status(201).json(rows[0]);
    }
    if (req.method === "PUT") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      const { numero, ordem, nome, pontuacao_maxima, regras, ativo } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      const max = Number(pontuacao_maxima);
      if (!Number.isFinite(max) || max <= 0) return bad(res, 400, "Pontuação máxima inválida.");
      const { rows } = await pool.query(
        `UPDATE provas SET numero = $1, ordem = $2, nome = $3, pontuacao_maxima = $4, regras = $5, ativo = $6
         WHERE id = $7
         RETURNING id, numero, ordem, nome, pontuacao_maxima, regras, ativo`,
        [
          numero ? String(numero).trim() : String(ordem || ""),
          Number.isFinite(Number(ordem)) ? Number(ordem) : 999,
          String(nome).trim(),
          max,
          regras ? String(regras) : "",
          ativo !== false,
          id,
        ]
      );
      if (!rows.length) return bad(res, 404, "Não encontrado.");
      return res.status(200).json(rows[0]);
    }
    if (req.method === "DELETE") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      await pool.query("DELETE FROM provas WHERE id = $1", [id]);
      return res.status(204).end();
    }
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return bad(res, 405, "Método não permitido.");
  }

  if (resource === "jurados") {
    if (req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT id, nome, token, ativo, criado_em FROM jurados ORDER BY criado_em ASC"
      );
      return res.status(200).json(rows);
    }
    if (req.method === "POST") {
      const { nome } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      const token = newToken();
      const { rows } = await pool.query(
        "INSERT INTO jurados (nome, token) VALUES ($1, $2) RETURNING id, nome, token, ativo, criado_em",
        [String(nome).trim(), token]
      );
      return res.status(201).json(rows[0]);
    }
    if (req.method === "PUT") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      const { nome, ativo, regenerar_token } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      const token = regenerar_token ? newToken() : undefined;
      const { rows } = await pool.query(
        token
          ? `UPDATE jurados SET nome = $1, ativo = $2, token = $3 WHERE id = $4
             RETURNING id, nome, token, ativo, criado_em`
          : `UPDATE jurados SET nome = $1, ativo = $2 WHERE id = $3
             RETURNING id, nome, token, ativo, criado_em`,
        token ? [String(nome).trim(), ativo !== false, token, id] : [String(nome).trim(), ativo !== false, id]
      );
      if (!rows.length) return bad(res, 404, "Não encontrado.");
      return res.status(200).json(rows[0]);
    }
    if (req.method === "DELETE") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      await pool.query("DELETE FROM jurados WHERE id = $1", [id]);
      return res.status(204).end();
    }
    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return bad(res, 405, "Método não permitido.");
  }

  if (resource === "pontuacoes") {
    if (req.method === "GET") {
      const { rows } = await pool.query(
        `SELECT p.id, p.pontos, p.atualizado_em, p.jurado_id, p.escola_id, p.prova_id,
                j.nome AS jurado_nome, e.nome AS escola_nome, pv.nome AS prova_nome,
                pv.pontuacao_maxima
         FROM pontuacoes p
         JOIN jurados j ON j.id = p.jurado_id
         JOIN schools e ON e.id = p.escola_id
         JOIN provas pv ON pv.id = p.prova_id
         ORDER BY pv.ordem ASC, e.nome ASC, j.nome ASC`
      );
      return res.status(200).json(rows);
    }
    if (req.method === "PUT") {
      // Correção de erro material (Art. 12, § único do Edital) por parte do administrador.
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      const pontosNum = Number((req.body || {}).pontos);
      if (!Number.isFinite(pontosNum) || pontosNum < 0) return bad(res, 400, "Pontuação inválida.");
      const { rows } = await pool.query(
        `SELECT pv.pontuacao_maxima FROM pontuacoes p JOIN provas pv ON pv.id = p.prova_id WHERE p.id = $1`,
        [id]
      );
      if (!rows.length) return bad(res, 404, "Não encontrado.");
      if (pontosNum > Number(rows[0].pontuacao_maxima)) {
        return bad(res, 400, `A pontuação não pode passar de ${rows[0].pontuacao_maxima} nesta prova.`);
      }
      const updated = await pool.query(
        "UPDATE pontuacoes SET pontos = $1, atualizado_em = now() WHERE id = $2 RETURNING id, pontos, atualizado_em",
        [pontosNum, id]
      );
      return res.status(200).json(updated.rows[0]);
    }
    if (req.method === "DELETE") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      await pool.query("DELETE FROM pontuacoes WHERE id = $1", [id]);
      return res.status(204).end();
    }
    res.setHeader("Allow", "GET, PUT, DELETE");
    return bad(res, 405, "Método não permitido.");
  }

  return bad(res, 404, "Recurso inválido.");
};

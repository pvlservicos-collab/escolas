const { getPool } = require("./_db");
const {
  signSession,
  requireAdminSession,
  safeEqual,
  newToken,
  slugify,
  secretsConfigured,
} = require("./_auth");
const { registrarLog } = require("./_config");

function bad(res, code, erro) {
  return res.status(code).json({ erro });
}

// Trava de força bruta no login: 5 tentativas erradas do mesmo IP bloqueiam por 15min.
const LOCKOUT_LIMIAR = 5;
const LOCKOUT_JANELA_MS = 15 * 60 * 1000;

function chaveCliente(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim();
  return "desconhecido";
}

async function loginBloqueado(pool, chave) {
  const { rows } = await pool.query("SELECT falhas, ultima_em FROM login_tentativas WHERE chave = $1", [chave]);
  if (!rows.length || rows[0].falhas < LOCKOUT_LIMIAR) return false;
  return Date.now() - new Date(rows[0].ultima_em).getTime() < LOCKOUT_JANELA_MS;
}

async function registrarFalhaLogin(pool, chave) {
  await pool.query(
    `INSERT INTO login_tentativas (chave, falhas, ultima_em) VALUES ($1, 1, now())
     ON CONFLICT (chave) DO UPDATE SET falhas = login_tentativas.falhas + 1, ultima_em = now()`,
    [chave]
  );
}

async function limparFalhasLogin(pool, chave) {
  await pool.query("DELETE FROM login_tentativas WHERE chave = $1", [chave]);
}

// Token curto e legível a partir do nome do jurado (ex: "Maria Silva" -> "maria-silva"),
// com sufixo numérico se já existir. `sufixoAleatorio` força um valor novo (usado ao
// gerar um novo link, para invalidar o anterior mesmo quando o nome não mudou).
async function tokenParaJurado(pool, nome, excluirId, sufixoAleatorio) {
  const base = slugify(nome) + (sufixoAleatorio ? "-" + newToken().slice(0, 4) : "");
  let candidato = base;
  let n = 2;
  while (true) {
    const { rows } = await pool.query(
      excluirId ? "SELECT id FROM jurados WHERE token = $1 AND id <> $2" : "SELECT id FROM jurados WHERE token = $1",
      excluirId ? [candidato, excluirId] : [candidato]
    );
    if (!rows.length) return candidato;
    candidato = base + "-" + n;
    n++;
  }
}

module.exports = async (req, res) => {
 try {
  // Fail closed: if any auth secret is unset, every check below would silently fall
  // back to an empty/guessable value (see _auth.js). Refuse to serve anything rather
  // than risk a blank-credential login bypass.
  if (!secretsConfigured()) {
    return bad(res, 500, "Configuração do servidor incompleta. Contate o administrador do sistema.");
  }

  const pool = getPool();
  const { resource } = req.query;
  const id = req.query.id !== undefined ? Number(req.query.id) : undefined;

  if (resource === "login") {
    if (req.method !== "POST") return bad(res, 405, "Método não permitido.");
    const chave = chaveCliente(req);
    if (await loginBloqueado(pool, chave)) {
      return bad(res, 429, "Muitas tentativas incorretas. Tente novamente em alguns minutos.");
    }
    const { usuario, senha } = req.body || {};
    const okUser =
      typeof usuario === "string" && safeEqual(usuario, process.env.ADMIN_USERNAME || "");
    const okPass =
      typeof senha === "string" && safeEqual(senha, process.env.ADMIN_PASSWORD || "");
    if (!okUser || !okPass) {
      await registrarFalhaLogin(pool, chave);
      return bad(res, 401, "Usuário ou senha inválidos.");
    }
    await limparFalhasLogin(pool, chave);
    return res.status(200).json({ token: signSession(usuario) });
  }

  // Everything below requires a valid logged-in session too.
  const session = requireAdminSession(req);
  if (!session) return bad(res, 401, "Sessão inválida ou expirada. Faça login novamente.");

  if (resource === "schools") {
    if (req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT id, nome, municipio, ativo, ordem_sorteio, dia_apresentacao, ordem_apresentacao FROM schools ORDER BY nome ASC"
      );
      return res.status(200).json(rows);
    }
    if (req.method === "POST") {
      const { nome, municipio, dia_apresentacao, ordem_apresentacao } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      const dia = ["11", "12"].includes(dia_apresentacao) ? dia_apresentacao : null;
      let ordemApresentacao = null;
      if (ordem_apresentacao !== undefined && ordem_apresentacao !== null && String(ordem_apresentacao).trim() !== "") {
        ordemApresentacao = Number(ordem_apresentacao);
        if (!Number.isInteger(ordemApresentacao)) return bad(res, 400, "Ordem de apresentação inválida.");
      }
      const { rows } = await pool.query(
        `INSERT INTO schools (nome, municipio, dia_apresentacao, ordem_apresentacao)
         VALUES ($1, $2, $3, $4)
         RETURNING id, nome, municipio, ativo, ordem_sorteio, dia_apresentacao, ordem_apresentacao`,
        [String(nome).trim(), municipio ? String(municipio).trim() : null, dia, ordemApresentacao]
      );
      return res.status(201).json(rows[0]);
    }
    if (req.method === "PUT") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      const { nome, municipio, ativo, ordem_sorteio, dia_apresentacao, ordem_apresentacao } = req.body || {};
      if (!nome || !String(nome).trim()) return bad(res, 400, "Nome é obrigatório.");
      let ordemSorteio = null;
      if (ordem_sorteio !== undefined && ordem_sorteio !== null && String(ordem_sorteio).trim() !== "") {
        ordemSorteio = Number(ordem_sorteio);
        if (!Number.isInteger(ordemSorteio)) return bad(res, 400, "Ordem de sorteio inválida.");
      }
      const dia = ["11", "12"].includes(dia_apresentacao) ? dia_apresentacao : null;
      let ordemApresentacao = null;
      if (ordem_apresentacao !== undefined && ordem_apresentacao !== null && String(ordem_apresentacao).trim() !== "") {
        ordemApresentacao = Number(ordem_apresentacao);
        if (!Number.isInteger(ordemApresentacao)) return bad(res, 400, "Ordem de apresentação inválida.");
      }
      const { rows } = await pool.query(
        `UPDATE schools SET nome = $1, municipio = $2, ativo = $3, ordem_sorteio = $4, dia_apresentacao = $5, ordem_apresentacao = $6
         WHERE id = $7 RETURNING id, nome, municipio, ativo, ordem_sorteio, dia_apresentacao, ordem_apresentacao`,
        [String(nome).trim(), municipio ? String(municipio).trim() : null, ativo !== false, ordemSorteio, dia, ordemApresentacao, id]
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
      const token = await tokenParaJurado(pool, String(nome).trim());
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
      const token = regenerar_token ? await tokenParaJurado(pool, String(nome).trim(), id, true) : undefined;
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
      // Exige motivo: essa é a única via que altera a nota de outra pessoa, então precisa
      // ficar registrada em pontuacoes_log com uma justificativa, não só o valor novo.
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      const { motivo } = req.body || {};
      if (!motivo || !String(motivo).trim()) return bad(res, 400, "Informe o motivo da correção.");
      const pontosNum = Number((req.body || {}).pontos);
      if (!Number.isFinite(pontosNum) || pontosNum < 0) return bad(res, 400, "Pontuação inválida.");
      const { rows } = await pool.query(
        `SELECT p.jurado_id, p.escola_id, p.prova_id, p.pontos, pv.pontuacao_maxima
         FROM pontuacoes p JOIN provas pv ON pv.id = p.prova_id WHERE p.id = $1`,
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
      await registrarLog(pool, {
        pontuacaoId: id,
        juradoId: rows[0].jurado_id,
        escolaId: rows[0].escola_id,
        provaId: rows[0].prova_id,
        acao: "correcao_admin",
        valorAntigo: Number(rows[0].pontos),
        valorNovo: pontosNum,
        autor: "admin: " + session.u,
        motivo: String(motivo).trim(),
      });
      return res.status(200).json(updated.rows[0]);
    }
    if (req.method === "DELETE") {
      if (!Number.isInteger(id)) return bad(res, 400, "Id inválido.");
      const motivo = req.query.motivo;
      if (!motivo || !String(motivo).trim()) return bad(res, 400, "Informe o motivo da exclusão.");
      const { rows } = await pool.query(
        "SELECT jurado_id, escola_id, prova_id, pontos FROM pontuacoes WHERE id = $1",
        [id]
      );
      if (!rows.length) return res.status(204).end();
      await pool.query("DELETE FROM pontuacoes WHERE id = $1", [id]);
      await registrarLog(pool, {
        pontuacaoId: id,
        juradoId: rows[0].jurado_id,
        escolaId: rows[0].escola_id,
        provaId: rows[0].prova_id,
        acao: "exclusao_admin",
        valorAntigo: Number(rows[0].pontos),
        valorNovo: null,
        autor: "admin: " + session.u,
        motivo: String(motivo).trim(),
      });
      return res.status(204).end();
    }
    res.setHeader("Allow", "GET, PUT, DELETE");
    return bad(res, 405, "Método não permitido.");
  }

  if (resource === "configuracao") {
    if (req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT encerrada, ranking_oculto FROM configuracao WHERE id = 1"
      );
      return res.status(200).json(rows[0] || { encerrada: false, ranking_oculto: false });
    }
    if (req.method === "PUT") {
      const { encerrada, ranking_oculto } = req.body || {};
      const { rows } = await pool.query(
        `UPDATE configuracao SET encerrada = $1, ranking_oculto = $2, atualizado_em = now()
         WHERE id = 1 RETURNING encerrada, ranking_oculto`,
        [Boolean(encerrada), Boolean(ranking_oculto)]
      );
      return res.status(200).json(rows[0]);
    }
    res.setHeader("Allow", "GET, PUT");
    return bad(res, 405, "Método não permitido.");
  }

  if (resource === "log") {
    if (req.method !== "GET") return bad(res, 405, "Método não permitido.");
    const { rows } = await pool.query(
      `SELECT l.id, l.acao, l.valor_antigo, l.valor_novo, l.autor, l.motivo, l.criado_em,
              e.nome AS escola_nome, pv.nome AS prova_nome
       FROM pontuacoes_log l
       LEFT JOIN schools e ON e.id = l.escola_id
       LEFT JOIN provas pv ON pv.id = l.prova_id
       ORDER BY l.criado_em DESC
       LIMIT 500`
    );
    return res.status(200).json(rows);
  }

  return bad(res, 404, "Recurso inválido.");
 } catch (err) {
  console.error("Erro em /api/admin:", err);
  if (!res.headersSent) return bad(res, 500, "Erro interno. Tente novamente em instantes.");
 }
};

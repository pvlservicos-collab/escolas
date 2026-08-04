const { getPool } = require("../_db");

const DIAS_VALIDOS = new Set(["11", "12", "13"]);

module.exports = async (req, res) => {
  const pool = getPool();
  const id = Number(req.query.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ erro: "Id inválido." });
  }

  if (req.method === "PUT") {
    const { nome, dia, pontos } = req.body || {};
    if (!nome || typeof nome !== "string" || !nome.trim()) {
      return res.status(400).json({ erro: "Nome é obrigatório." });
    }
    if (!DIAS_VALIDOS.has(dia)) {
      return res.status(400).json({ erro: "Dia inválido." });
    }
    const pontosNum = Number(pontos);
    if (!Number.isFinite(pontosNum)) {
      return res.status(400).json({ erro: "Pontuação inválida." });
    }

    const { rows } = await pool.query(
      "UPDATE escolas SET nome = $1, dia = $2, pontos = $3 WHERE id = $4 RETURNING id, nome, dia, pontos",
      [nome.trim(), dia, pontosNum, id]
    );
    if (!rows.length) return res.status(404).json({ erro: "Não encontrado." });
    return res.status(200).json(rows[0]);
  }

  if (req.method === "DELETE") {
    await pool.query("DELETE FROM escolas WHERE id = $1", [id]);
    return res.status(204).end();
  }

  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ erro: "Método não permitido." });
};

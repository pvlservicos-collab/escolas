const { getPool } = require("./_db");

const DIAS_VALIDOS = new Set(["11", "12", "13"]);

module.exports = async (req, res) => {
  const pool = getPool();

  if (req.method === "GET") {
    const { rows } = await pool.query(
      "SELECT id, nome, dia, pontos FROM escolas ORDER BY criado_em ASC"
    );
    return res.status(200).json(rows);
  }

  if (req.method === "POST") {
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
      "INSERT INTO escolas (nome, dia, pontos) VALUES ($1, $2, $3) RETURNING id, nome, dia, pontos",
      [nome.trim(), dia, pontosNum]
    );
    return res.status(201).json(rows[0]);
  }

  if (req.method === "DELETE") {
    await pool.query("DELETE FROM escolas");
    return res.status(204).end();
  }

  res.setHeader("Allow", "GET, POST, DELETE");
  return res.status(405).json({ erro: "Método não permitido." });
};

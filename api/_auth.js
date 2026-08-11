const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function hmac(value) {
  const secret = process.env.SESSION_SECRET || "";
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signSession(usuario) {
  const payload = JSON.stringify({ u: usuario, exp: Date.now() + SESSION_TTL_MS });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  return b64 + "." + hmac(b64);
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [b64, mac] = token.split(".");
  if (!safeEqual(mac, hmac(b64))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdminSession(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifySession(token);
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

// If any of these are unset, every helper above quietly falls back to "" (empty
// secret): hmac() signs sessions with a public, guessable key, and safeEqual("", "")
// makes blank username/password pass login. Missing config must fail closed (500),
// never silently open the admin panel to blank credentials.
const REQUIRED_ENV = ["SESSION_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD"];

function secretsConfigured() {
  return REQUIRED_ENV.every((k) => typeof process.env[k] === "string" && process.env[k].length > 0);
}

// Turns a jurado's name into a short, readable URL token, e.g. "Maria Silva" -> "maria-silva".
function slugify(nome) {
  const base = String(nome)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "jurado";
}

module.exports = {
  signSession,
  verifySession,
  requireAdminSession,
  safeEqual,
  newToken,
  slugify,
  secretsConfigured,
};

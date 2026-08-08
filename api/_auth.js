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

// Requires both the admin link secret (?key= on the front-end, sent as a header
// on every admin API call) and, beyond login, a valid session from a successful
// username/password login.
function requireAdminKey(req) {
  const key = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_LINK_SECRET || "";
  if (!expected) return false;
  return typeof key === "string" && safeEqual(key, expected);
}

function requireAdminSession(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  return verifySession(token);
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

module.exports = {
  signSession,
  verifySession,
  requireAdminKey,
  requireAdminSession,
  safeEqual,
  newToken,
};

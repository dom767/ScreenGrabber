export function parseOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** http(s)://localhost or 127.0.0.1 with any port — local static servers. */
function isLocalDevOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function corsHeaders(env, originHeader) {
  const origin = originHeader || "";
  const allowed = parseOrigins(env);
  const ok = !!(origin && (allowed.includes(origin) || isLocalDevOrigin(origin)));
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (ok) headers["Access-Control-Allow-Origin"] = origin;
  return { ok, origin, headers };
}

export function withCors(env, originHeader, response) {
  const { headers } = corsHeaders(env, originHeader);
  return {
    ...response,
    headers: { ...(response.headers || {}), ...headers },
  };
}

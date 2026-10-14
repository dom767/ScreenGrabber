import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, DeleteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

function b64url(bytes) {
  let bin = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return Buffer.from(bin, "binary")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlJson(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function sign(secret, data) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return b64url(sig);
}

function parseB64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

export async function issueTicket(env, { appId, bytes, contentSha256 }) {
  const ttl = Number(env.TICKET_TTL_SEC || 120);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    jti: crypto.randomUUID(),
    appId,
    bytes,
    contentSha256,
    iat: now,
    exp: now + ttl,
  };
  const body = b64urlJson(payload);
  const sig = await sign(env.TICKET_HMAC_SECRET, body);
  return `${body}.${sig}`;
}

export async function verifyTicket(env, token, { appId, bytes, contentSha256 }) {
  if (!token || typeof token !== "string") return { ok: false, error: "missing ticket" };
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "bad ticket" };
  const [body, sig] = parts;
  const expect = await sign(env.TICKET_HMAC_SECRET, body);
  if (sig !== expect) return { ok: false, error: "bad ticket signature" };

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(parseB64url(body)));
  } catch {
    return { ok: false, error: "bad ticket payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return { ok: false, error: "ticket expired" };
  if (payload.appId !== appId) return { ok: false, error: "ticket app mismatch" };
  if (Number(payload.bytes) !== Number(bytes)) return { ok: false, error: "ticket size mismatch" };
  if (payload.contentSha256 !== contentSha256) {
    return { ok: false, error: "ticket hash mismatch" };
  }

  return { ok: true, payload };
}

export async function consumeTicket(doc, tableName, jti, expiresAt) {
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: { jti, expiresAt },
        ConditionExpression: "attribute_not_exists(jti)",
      })
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException || err?.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

export async function purgeExpiredTickets(doc, tableName) {
  const now = Math.floor(Date.now() / 1000);
  // TTL usually handles this; opportunistic cleanup for safety.
  const res = await doc.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "expiresAt < :now",
      ExpressionAttributeValues: { ":now": now },
      ProjectionExpression: "jti",
      Limit: 50,
    })
  );
  for (const item of res.Items || []) {
    await doc.send(new DeleteCommand({ TableName: tableName, Key: { jti: item.jti } }));
  }
}

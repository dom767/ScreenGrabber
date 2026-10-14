import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { corsHeaders, withCors } from "./cors.js";
import {
  issueTicket,
  verifyTicket,
  consumeTicket,
  purgeExpiredTickets,
} from "./ticket.js";
import { validateImageBytes, sha256Hex } from "./image.js";
import { rateLimit } from "./ratelimit.js";
import { parseMultipart } from "./multipart.js";
import { ADMIN_HTML } from "./adminHtml.js";

const ALLOWED_STATUS = new Set(["pending", "approved", "hidden"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});

function env() {
  return {
    SHOTS_TABLE: process.env.SHOTS_TABLE || "baffledcat-shots",
    TICKETS_TABLE: process.env.TICKETS_TABLE || "baffledcat-shots-tickets",
    BUCKET: process.env.SHOTS_BUCKET || "baffledcat-shots",
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || "",
    ALLOWED_APP_IDS: process.env.ALLOWED_APP_IDS || "mandelbrot",
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "",
    MAX_UPLOAD_BYTES: process.env.MAX_UPLOAD_BYTES || "2097152",
    MAX_EDGE: process.env.MAX_EDGE || "1920",
    THUMB_EDGE: process.env.THUMB_EDGE || "256",
    TICKET_TTL_SEC: process.env.TICKET_TTL_SEC || "120",
    TICKET_HMAC_SECRET: process.env.TICKET_HMAC_SECRET || "",
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || "",
    TURNSTILE_SECRET: process.env.TURNSTILE_SECRET || "",
    DEV_BYPASS_TURNSTILE: process.env.DEV_BYPASS_TURNSTILE || "",
  };
}

function json(data, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data),
  };
}

function html(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body,
  };
}

function binary(buf, contentType, extraHeaders = {}) {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...extraHeaders,
    },
    body: Buffer.from(buf).toString("base64"),
    isBase64Encoded: true,
  };
}

function allowedApps(e) {
  return String(e.ALLOWED_APP_IDS || "mandelbrot")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function clientIp(event) {
  return (
    event.requestContext?.http?.sourceIp ||
    event.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function header(event, name) {
  const h = event.headers || {};
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? h[key] : "";
}

async function hashIp(ip, secret) {
  const data = new TextEncoder().encode(`${secret || "x"}:${ip}`);
  const dig = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(dig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function verifyTurnstile(e, token, ip) {
  if (e.DEV_BYPASS_TURNSTILE === "1") return true;
  if (!e.TURNSTILE_SECRET) return false;
  if (!token) return false;
  const body = new URLSearchParams();
  body.set("secret", e.TURNSTILE_SECRET);
  body.set("response", token);
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  const res = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body }
  );
  const data = await res.json();
  return !!data.success;
}

function decodeBody(event) {
  if (!event.body) return Buffer.alloc(0);
  return Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
}

export async function handler(event) {
  const e = env();
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path = (event.rawPath || event.path || "/").replace(/\/+$/, "") || "/";
  const origin = header(event, "origin");

  try {
    if (method === "OPTIONS") {
      const { headers, ok } = corsHeaders(e, origin);
      return { statusCode: ok ? 204 : 403, headers, body: "" };
    }

    let response;
    if (path === "/v1/ticket" && method === "POST") {
      response = await handleTicket(event, e, origin);
    } else if (path === "/v1/shots" && method === "POST") {
      response = await handleUpload(event, e, origin);
    } else if (path === "/v1/shots" && method === "GET") {
      response = await handleList(event, e, { admin: false });
    } else if (path.startsWith("/v1/shots/") && method === "GET") {
      response = await handleGet(path.slice("/v1/shots/".length), e, false);
    } else if (path === "/v1/admin/shots" && method === "GET") {
      response = await requireAdmin(event, e, () => handleList(event, e, { admin: true }));
    } else if (path.startsWith("/v1/admin/shots/") && method === "DELETE") {
      response = await requireAdmin(event, e, () =>
        handleAdminDelete(path.slice("/v1/admin/shots/".length), e)
      );
    } else if (path.startsWith("/v1/admin/shots/") && method === "PATCH") {
      response = await requireAdmin(event, e, () =>
        handleAdminPatch(path.slice("/v1/admin/shots/".length), event, e)
      );
    } else if (path.startsWith("/i/") && method === "GET") {
      response = await handleAsset(path.slice(3), e);
    } else if (path === "/" || path === "/health") {
      response = json({ ok: true, service: "baffledcat-screenshots" });
    } else if (path === "/admin" || path.startsWith("/admin/")) {
      response = path === "/admin" || path === "/admin/" ? html(ADMIN_HTML) : json({ error: "not found" }, 404);
    } else {
      response = json({ error: "not found" }, 404);
    }

    return withCors(e, origin, response);
  } catch (err) {
    console.error(err);
    return withCors(e, origin, json({ error: "internal error" }, 500));
  }
}

async function handleTicket(event, e, origin) {
  const { ok: originOk } = corsHeaders(e, origin);
  if (!originOk) return json({ error: "origin not allowed" }, 403);

  const ip = clientIp(event);
  if (!rateLimit(`ticket:${ip}`, { limit: 30, windowMs: 60_000 })) {
    return json({ error: "rate limited" }, 429);
  }

  let body;
  try {
    body = JSON.parse(decodeBody(event).toString("utf8") || "{}");
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const appId = String(body.appId || "");
  if (!allowedApps(e).includes(appId)) {
    return json({ error: "unknown appId" }, 400);
  }

  const bytes = Number(body.bytes);
  const contentSha256 = String(body.contentSha256 || "");
  if (!Number.isFinite(bytes) || bytes < 1 || bytes > Number(e.MAX_UPLOAD_BYTES || 2_097_152)) {
    return json({ error: "invalid bytes" }, 400);
  }
  if (!/^[a-f0-9]{64}$/i.test(contentSha256)) {
    return json({ error: "invalid contentSha256" }, 400);
  }

  const turnstileOk = await verifyTurnstile(e, body.turnstileToken, ip);
  if (!turnstileOk) return json({ error: "turnstile failed" }, 403);

  if (!e.TICKET_HMAC_SECRET) {
    return json({ error: "server misconfigured" }, 500);
  }

  const ticket = await issueTicket(e, { appId, bytes, contentSha256 });
  return json({ ticket, expiresIn: Number(e.TICKET_TTL_SEC || 120) });
}

async function handleUpload(event, e, origin) {
  const { ok: originOk } = corsHeaders(e, origin);
  if (!originOk) return json({ error: "origin not allowed" }, 403);

  const ip = clientIp(event);
  if (!rateLimit(`upload:${ip}`, { limit: 15, windowMs: 60_000 })) {
    return json({ error: "rate limited" }, 429);
  }

  const contentType = header(event, "content-type");
  let fields;
  let files;
  try {
    ({ fields, files } = parseMultipart(decodeBody(event), contentType));
  } catch {
    return json({ error: "expected multipart form" }, 400);
  }

  const ticket = String(fields.ticket || "");
  const appId = String(fields.appId || "");
  const pageUrl = String(fields.pageUrl || "").slice(0, 2048);
  const title = sanitizeText(fields.title, 120);
  const note = sanitizeText(fields.note, 500);
  let metaJson = fields.meta || fields.meta_json || "{}";
  if (metaJson.length > 8000) return json({ error: "meta too large" }, 400);

  const imageFile = files.image;
  const thumbFile = files.thumb;
  if (!imageFile || !thumbFile) {
    return json({ error: "image and thumb required" }, 400);
  }

  const imageBuf = new Uint8Array(imageFile.data);
  const thumbBuf = new Uint8Array(thumbFile.data);

  const imgCheck = validateImageBytes(imageBuf, e, { expectSquare: false });
  if (!imgCheck.ok) return json({ error: imgCheck.error }, 400);
  const thumbCheck = validateImageBytes(thumbBuf, e, { expectSquare: true });
  if (!thumbCheck.ok) return json({ error: thumbCheck.error }, 400);

  const contentSha256 = await sha256Hex(imageBuf);
  const verified = await verifyTicket(e, ticket, {
    appId,
    bytes: imageBuf.length,
    contentSha256,
  });
  if (!verified.ok) return json({ error: verified.error }, 403);

  // fire-and-forget cleanup
  purgeExpiredTickets(ddb, e.TICKETS_TABLE).catch(() => {});
  const consumed = await consumeTicket(
    ddb,
    e.TICKETS_TABLE,
    verified.payload.jti,
    verified.payload.exp
  );
  if (!consumed) return json({ error: "ticket already used" }, 403);

  if (!allowedApps(e).includes(appId)) {
    return json({ error: "unknown appId" }, 400);
  }

  const id = crypto.randomUUID().replace(/-/g, "");
  const ext = extForMime(imgCheck.mime);
  const imageKey = `shots/${appId}/${id}.${ext}`;
  const thumbKey = `shots/${appId}/${id}_thumb.jpg`;

  await s3.send(
    new PutObjectCommand({
      Bucket: e.BUCKET,
      Key: imageKey,
      Body: Buffer.from(imageBuf),
      ContentType: imgCheck.mime,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  await s3.send(
    new PutObjectCommand({
      Bucket: e.BUCKET,
      Key: thumbKey,
      Body: Buffer.from(thumbBuf),
      ContentType: "image/jpeg",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const createdAt = Date.now();
  const ipHash = await hashIp(ip, e.TICKET_HMAC_SECRET);
  const status = "approved";
  const item = {
    id,
    appId,
    createdAt,
    imageKey,
    thumbKey,
    width: imgCheck.width,
    height: imgCheck.height,
    bytes: imgCheck.bytes,
    mime: imgCheck.mime,
    thumbSize: thumbCheck.width,
    pageUrl: pageUrl || null,
    title,
    note,
    metaJson,
    status,
    ipHash,
    appStatus: `${appId}#${status}`,
  };

  await ddb.send(new PutCommand({ TableName: e.SHOTS_TABLE, Item: item }));

  const base = (e.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return json({
    id,
    imageUrl: `${base}/i/${imageKey}`,
    thumbUrl: `${base}/i/${thumbKey}`,
    width: imgCheck.width,
    height: imgCheck.height,
    status,
  });
}

function extForMime(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function sanitizeText(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/[\u0000-\u001f<>]/g, "").trim();
  if (!s) return null;
  return s.slice(0, max);
}

async function handleList(event, e, { admin }) {
  const qs = event.queryStringParameters || {};
  const appId = qs.app_id || qs.appId;
  const limit = Math.min(500, Math.max(1, Number(qs.limit || 50)));
  const cursor = qs.cursor;
  const status = admin ? qs.status || null : "approved";

  if (status && !ALLOWED_STATUS.has(status) && status !== "all") {
    return json({ error: "bad status" }, 400);
  }

  let items = [];
  if (appId && status && status !== "all") {
    items = await queryByAppStatus(e, appId, status, limit, cursor);
  } else if (status && status !== "all") {
    items = await queryByStatus(e, status, limit, cursor);
  } else if (appId) {
    // admin: all statuses for one app — query each status
    const parts = await Promise.all(
      [...ALLOWED_STATUS].map((st) => queryByAppStatus(e, appId, st, limit, null))
    );
    items = parts.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    if (cursor) {
      const c = Number(cursor);
      items = items.filter((x) => x.createdAt < c).slice(0, limit);
    }
  } else {
    const parts = await Promise.all(
      [...ALLOWED_STATUS].map((st) => queryByStatus(e, st, limit, null))
    );
    items = parts.flat().sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    if (cursor) {
      const c = Number(cursor);
      items = items.filter((x) => x.createdAt < c).slice(0, limit);
    }
  }

  const base = (e.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const shots = items.map((row) => publicShot(row, base));
  const nextCursor =
    shots.length === limit ? String(shots[shots.length - 1].createdAt) : null;

  return json({ shots, nextCursor });
}

async function queryByAppStatus(e, appId, status, limit, cursor) {
  const params = {
    TableName: e.SHOTS_TABLE,
    IndexName: "appStatus-createdAt-index",
    KeyConditionExpression: "appStatus = :as",
    ExpressionAttributeValues: { ":as": `${appId}#${status}` },
    ScanIndexForward: false,
    Limit: limit,
  };
  if (cursor && Number.isFinite(Number(cursor))) {
    params.KeyConditionExpression += " AND createdAt < :c";
    params.ExpressionAttributeValues[":c"] = Number(cursor);
  }
  const res = await ddb.send(new QueryCommand(params));
  return res.Items || [];
}

async function queryByStatus(e, status, limit, cursor) {
  const params = {
    TableName: e.SHOTS_TABLE,
    IndexName: "status-createdAt-index",
    KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": status },
    ScanIndexForward: false,
    Limit: limit,
  };
  if (cursor && Number.isFinite(Number(cursor))) {
    params.KeyConditionExpression += " AND createdAt < :c";
    params.ExpressionAttributeValues[":c"] = Number(cursor);
  }
  const res = await ddb.send(new QueryCommand(params));
  return res.Items || [];
}

async function handleGet(id, e, admin) {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  const res = await ddb.send(
    new GetCommand({ TableName: e.SHOTS_TABLE, Key: { id: clean } })
  );
  const row = res.Item;
  if (!row) return json({ error: "not found" }, 404);
  if (!admin && row.status !== "approved") return json({ error: "not found" }, 404);
  const base = (e.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  return json({ shot: publicShot(row, base) });
}

function publicShot(row, base) {
  let meta = null;
  try {
    meta = row.metaJson ? JSON.parse(row.metaJson) : null;
  } catch {
    meta = null;
  }
  return {
    id: row.id,
    appId: row.appId,
    createdAt: row.createdAt,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    mime: row.mime,
    thumbSize: row.thumbSize,
    pageUrl: row.pageUrl,
    title: row.title,
    note: row.note,
    meta,
    status: row.status,
    imageUrl: `${base}/i/${row.imageKey}`,
    thumbUrl: `${base}/i/${row.thumbKey}`,
  };
}

async function handleAsset(key, e) {
  const clean = key.replace(/^\/+/, "");
  if (!clean.startsWith("shots/") || clean.includes("..")) {
    return json({ error: "not found" }, 404);
  }
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: e.BUCKET, Key: clean })
    );
    const bytes = Buffer.from(await obj.Body.transformToByteArray());
    return binary(bytes, obj.ContentType || "application/octet-stream");
  } catch (err) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return json({ error: "not found" }, 404);
    }
    throw err;
  }
}

async function requireAdmin(event, e, fn) {
  const auth = header(event, "authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!e.ADMIN_TOKEN || token !== e.ADMIN_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  return fn();
}

async function handleAdminDelete(id, e) {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  const res = await ddb.send(
    new GetCommand({ TableName: e.SHOTS_TABLE, Key: { id: clean } })
  );
  if (!res.Item) return json({ error: "not found" }, 404);

  await ddb.send(
    new UpdateCommand({
      TableName: e.SHOTS_TABLE,
      Key: { id: clean },
      UpdateExpression: "SET #s = :h, appStatus = :as",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":h": "hidden",
        ":as": `${res.Item.appId}#hidden`,
      },
    })
  );
  return json({ ok: true, id: clean, status: "hidden" });
}

async function handleAdminPatch(id, event, e) {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  let body;
  try {
    body = JSON.parse(decodeBody(event).toString("utf8") || "{}");
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const status = String(body.status || "");
  if (!ALLOWED_STATUS.has(status)) return json({ error: "bad status" }, 400);

  const res = await ddb.send(
    new GetCommand({ TableName: e.SHOTS_TABLE, Key: { id: clean } })
  );
  if (!res.Item) return json({ error: "not found" }, 404);

  if (status === "hidden" && body.hardDelete) {
    await s3.send(new DeleteObjectCommand({ Bucket: e.BUCKET, Key: res.Item.imageKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: e.BUCKET, Key: res.Item.thumbKey }));
    await ddb.send(new DeleteCommand({ TableName: e.SHOTS_TABLE, Key: { id: clean } }));
    return json({ ok: true, deleted: true });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: e.SHOTS_TABLE,
      Key: { id: clean },
      UpdateExpression: "SET #s = :st, appStatus = :as",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":st": status,
        ":as": `${res.Item.appId}#${status}`,
      },
    })
  );
  return json({ ok: true, id: clean, status });
}

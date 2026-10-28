import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handler, s3, ddb } from "../src/handler.js";
import { sha256Hex } from "../src/image.js";

const productionConfig = JSON.parse(
  await readFile(new URL("../config.production.json", import.meta.url), "utf8")
);

const originalFetch = globalThis.fetch;
const originalS3Send = s3.send;
const originalDdbSend = ddb.send;

let s3Commands = [];
let ddbCommands = [];
let fetchCalls = [];

test.beforeEach(() => {
  process.env.ALLOWED_ORIGINS = productionConfig.allowedOrigins.join(",");
  process.env.ALLOWED_APP_IDS = productionConfig.allowedAppIds.join(",");
  process.env.DEV_BYPASS_TURNSTILE = "1";
  process.env.TICKET_HMAC_SECRET = "test-only-ticket-secret";
  process.env.TURNSTILE_SECRET = "test-only-turnstile-secret";
  process.env.PUBLIC_BASE_URL = "https://shots.baffledcat.com";

  s3Commands = [];
  ddbCommands = [];
  fetchCalls = [];

  s3.send = async (cmd) => {
    s3Commands.push(cmd);
    return {};
  };
  ddb.send = async (cmd) => {
    ddbCommands.push(cmd);
    return {};
  };
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ success: true }) };
  };
});

test.afterEach(() => {
  s3.send = originalS3Send;
  ddb.send = originalDdbSend;
  globalThis.fetch = originalFetch;
});

function ticketEvent({
  appId = "bifurcation",
  origin = "https://baffledcat.com",
  bytes = 1024,
  contentSha256 = "a".repeat(64),
  sourceIp = "203.0.113.10",
} = {}) {
  return {
    rawPath: "/v1/ticket",
    headers: { origin, "user-agent": "test-agent/1.0" },
    requestContext: { http: { method: "POST", sourceIp } },
    body: JSON.stringify({
      appId,
      bytes,
      contentSha256,
      turnstileToken: "test-bypass",
    }),
  };
}

function makeFakePng(width, height) {
  const buf = new Uint8Array(32);
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(buf.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return buf;
}

function buildMultipartBody({ fields = {}, files = {} }, boundary = "----TestBoundary7MA4YWxkTrZu0gW") {
  const chunks = [];
  const CRLF = Buffer.from("\r\n");

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }

  for (const [name, file] of Object.entries(files)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file.filename || "file"}"\r\nContent-Type: ${file.mime || "application/octet-stream"}\r\n\r\n`
      )
    );
    chunks.push(Buffer.from(file.data));
    chunks.push(CRLF);
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    boundary,
    body: Buffer.concat(chunks),
  };
}

test("production config accepts bifurcation tickets from baffledcat.com", async () => {
  const response = await handler(ticketEvent());

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://baffledcat.com");
  assert.equal(typeof JSON.parse(response.body).ticket, "string");
  assert.equal(s3Commands.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("ticket validation submits the configured Turnstile secret", async () => {
  process.env.DEV_BYPASS_TURNSTILE = "0";
  let verificationBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    verificationBody = options.body;
    return { ok: true, json: async () => ({ success: true }) };
  };

  const response = await handler(ticketEvent());

  assert.equal(response.statusCode, 200);
  assert.equal(verificationBody.get("secret"), "test-only-turnstile-secret");
  assert.equal(verificationBody.get("response"), "test-bypass");
});

test("unknown app IDs on ticket return a decoy 200 success, store private S3 log, and email images@baffledcat.com", async () => {
  const response = await handler(ticketEvent({ appId: "unknown-app", sourceIp: "203.0.113.11" }));

  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(typeof data.ticket, "string");
  assert.equal(typeof data.expiresIn, "number");
  assert.equal(data.error, undefined);

  assert.equal(s3Commands.length, 1);
  const putLog = s3Commands[0].input;
  assert.equal(putLog.Bucket, "baffledcat-shots");
  assert.match(putLog.Key, /^logs\/failed-attempts\/\d{4}-\d{2}-\d{2}\//);
  const savedLog = JSON.parse(putLog.Body);
  assert.equal(savedLog.endpoint, "/v1/ticket");
  assert.equal(savedLog.reason, "unknown appId");
  assert.equal(savedLog.appId, "unknown-app");
  assert.equal(savedLog.alertEmail, "images@baffledcat.com");

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /email\.eu-west-2\.amazonaws\.com\/v2\/email\/outbound-emails$/);
  const emailPayload = JSON.parse(fetchCalls[0].options.body);
  assert.deepEqual(emailPayload.Destination.ToAddresses, ["images@baffledcat.com"]);
  assert.match(emailPayload.Content.Simple.Subject.Data, /unknown appId/);
  assert.match(emailPayload.Content.Simple.Body.Text.Data, /unknown-app/);
});

test("origins outside the exact allowlist return a decoy 200 without CORS allow header and log/email the attempt", async () => {
  const response = await handler(
    ticketEvent({ origin: "https://baffledcat.com.example.org", sourceIp: "203.0.113.12" })
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  const data = JSON.parse(response.body);
  assert.equal(typeof data.ticket, "string");
  assert.equal(data.error, undefined);

  assert.equal(s3Commands.length, 1);
  const savedLog = JSON.parse(s3Commands[0].input.Body);
  assert.equal(savedLog.reason, "origin not allowed");
  assert.equal(savedLog.origin, "https://baffledcat.com.example.org");

  assert.equal(fetchCalls.length, 1);
  const emailPayload = JSON.parse(fetchCalls[0].options.body);
  assert.deepEqual(emailPayload.Destination.ToAddresses, ["images@baffledcat.com"]);
  assert.match(emailPayload.Content.Simple.Subject.Data, /origin not allowed/);
});

test("invalid image upload returns a 200 decoy shot without storing the image, logs privately in S3, and emails images@baffledcat.com", async () => {
  const validImage = makeFakePng(800, 600);
  const invalidThumb = makeFakePng(200, 150); // not 256x256 square
  const { boundary, body } = buildMultipartBody({
    fields: {
      ticket: "decoy.ticket",
      appId: "unrecognised-app",
      pageUrl: "https://baffledcat.com/test",
    },
    files: {
      image: { filename: "shot.png", mime: "image/png", data: validImage },
      thumb: { filename: "thumb.png", mime: "image/png", data: invalidThumb },
    },
  });

  const response = await handler({
    rawPath: "/v1/shots",
    headers: {
      origin: "https://baffledcat.com",
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    requestContext: { http: { method: "POST", sourceIp: "203.0.113.13" } },
    body: body.toString("base64"),
    isBase64Encoded: true,
  });

  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.status, "approved");
  assert.equal(typeof data.id, "string");
  assert.match(data.imageUrl, /^https:\/\/shots\.baffledcat\.com\/i\/shots\//);
  assert.match(data.thumbUrl, /^https:\/\/shots\.baffledcat\.com\/i\/shots\//);
  assert.equal(data.error, undefined);

  // Image and metadata must NOT be stored to shots/ or DynamoDB SHOTS_TABLE
  const shotPuts = s3Commands.filter((c) => c.input?.Key?.startsWith("shots/"));
  assert.equal(shotPuts.length, 0);
  assert.equal(ddbCommands.length, 0);

  // Private failure log MUST be stored in S3 under logs/failed-attempts/
  assert.equal(s3Commands.length, 1);
  const logPut = s3Commands[0].input;
  assert.match(logPut.Key, /^logs\/failed-attempts\//);
  const savedLog = JSON.parse(logPut.Body);
  assert.equal(savedLog.endpoint, "/v1/shots");
  assert.equal(savedLog.reason, "unknown appId");
  assert.ok(savedLog.reasons.includes("unknown appId"));
  assert.ok(savedLog.reasons.includes("thumb must be square"));
  assert.ok(savedLog.reasons.includes("bad ticket signature"));

  // Alert email MUST be sent to images@baffledcat.com
  assert.equal(fetchCalls.length, 1);
  const emailPayload = JSON.parse(fetchCalls[0].options.body);
  assert.deepEqual(emailPayload.Destination.ToAddresses, ["images@baffledcat.com"]);
  assert.match(emailPayload.Content.Simple.Body.Text.Data, /s3:\/\/baffledcat-shots\/logs\/failed-attempts\//);

  // Public /i/ route must NOT expose private logs
  const assetRes = await handler({
    rawPath: `/i/${logPut.Key}`,
    headers: {},
    requestContext: { http: { method: "GET", sourceIp: "203.0.113.13" } },
  });
  assert.equal(assetRes.statusCode, 404);
});

test("valid image upload stores image, thumbnail, and metadata without logging a failure", async () => {
  const validImage = makeFakePng(800, 600);
  const validThumb = makeFakePng(256, 256);
  const contentSha256 = await sha256Hex(validImage);

  const ticketRes = await handler(
    ticketEvent({
      appId: "mandelbrot",
      bytes: validImage.length,
      contentSha256,
      sourceIp: "203.0.113.14",
    })
  );
  const { ticket } = JSON.parse(ticketRes.body);

  const { boundary, body } = buildMultipartBody({
    fields: {
      ticket,
      appId: "mandelbrot",
      pageUrl: "https://baffledcat.com/mandelbrot",
    },
    files: {
      image: { filename: "shot.png", mime: "image/png", data: validImage },
      thumb: { filename: "thumb.png", mime: "image/png", data: validThumb },
    },
  });

  const upRes = await handler({
    rawPath: "/v1/shots",
    headers: {
      origin: "https://baffledcat.com",
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    requestContext: { http: { method: "POST", sourceIp: "203.0.113.14" } },
    body: body.toString("base64"),
    isBase64Encoded: true,
  });

  assert.equal(upRes.statusCode, 200);
  const upData = JSON.parse(upRes.body);
  assert.equal(upData.status, "approved");
  assert.equal(upData.width, 800);
  assert.equal(upData.height, 600);

  const shotPuts = s3Commands.filter((c) => c.input?.Key?.startsWith("shots/mandelbrot/"));
  assert.equal(shotPuts.length, 2);
  const logPuts = s3Commands.filter((c) => c.input?.Key?.startsWith("logs/"));
  assert.equal(logPuts.length, 0);
  assert.equal(fetchCalls.length, 0);
});

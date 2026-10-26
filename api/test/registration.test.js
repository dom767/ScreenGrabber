import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handler } from "../src/handler.js";

const productionConfig = JSON.parse(
  await readFile(new URL("../config.production.json", import.meta.url), "utf8")
);

test.beforeEach(() => {
  process.env.ALLOWED_ORIGINS = productionConfig.allowedOrigins.join(",");
  process.env.ALLOWED_APP_IDS = productionConfig.allowedAppIds.join(",");
  process.env.DEV_BYPASS_TURNSTILE = "1";
  process.env.TICKET_HMAC_SECRET = "test-only-ticket-secret";
  process.env.TURNSTILE_SECRET = "test-only-turnstile-secret";
});

function ticketEvent({ appId = "bifurcation", origin = "https://baffledcat.com" } = {}) {
  return {
    rawPath: "/v1/ticket",
    headers: { origin },
    requestContext: { http: { method: "POST", sourceIp: "203.0.113.10" } },
    body: JSON.stringify({
      appId,
      bytes: 1024,
      contentSha256: "a".repeat(64),
      turnstileToken: "test-bypass",
    }),
  };
}

test("production config accepts bifurcation tickets from baffledcat.com", async () => {
  const response = await handler(ticketEvent());

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Access-Control-Allow-Origin"], "https://baffledcat.com");
  assert.equal(typeof JSON.parse(response.body).ticket, "string");
});

test("ticket validation submits the configured Turnstile secret", async () => {
  process.env.DEV_BYPASS_TURNSTILE = "0";
  const originalFetch = globalThis.fetch;
  let verificationBody;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    verificationBody = options.body;
    return { json: async () => ({ success: true }) };
  };

  try {
    const response = await handler(ticketEvent());

    assert.equal(response.statusCode, 200);
    assert.equal(verificationBody.get("secret"), "test-only-turnstile-secret");
    assert.equal(verificationBody.get("response"), "test-bypass");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("production config rejects unknown app IDs", async () => {
  const response = await handler(ticketEvent({ appId: "unknown-app" }));

  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: "unknown appId" });
});

test("production config rejects origins outside the exact allowlist", async () => {
  const response = await handler(
    ticketEvent({ origin: "https://baffledcat.com.example.org" })
  );

  assert.equal(response.statusCode, 403);
  assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  assert.deepEqual(JSON.parse(response.body), { error: "origin not allowed" });
});

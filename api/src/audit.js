import { createHash, createHmac } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";

export const DEFAULT_ALERT_EMAIL = "images@baffledcat.com";
export const DEFAULT_LOG_PREFIX = "logs/failed-attempts";

const nativeFetch = globalThis.fetch;

class Sha256 {
  constructor(secret) {
    this.hash = secret ? createHmac("sha256", secret) : createHash("sha256");
  }
  update(data) {
    this.hash.update(data);
  }
  async digest() {
    return new Uint8Array(this.hash.digest());
  }
}

async function resolveCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
    };
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return {
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
    };
  }
  try {
    return await defaultProvider()();
  } catch {
    return {
      accessKeyId: "unconfigured",
      secretAccessKey: "unconfigured",
    };
  }
}

export async function sendFailureEmail(env, logEntry) {
  const toEmail = env.ALERT_EMAIL || DEFAULT_ALERT_EMAIL;
  const fromEmail = env.ALERT_FROM_EMAIL || toEmail;
  const region =
    env.AWS_REGION ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    "eu-west-2";

  const subject = `[ScreenGrabber] Failed validation (${logEntry.endpoint}): ${logEntry.reason}`;
  const textBody = [
    "An attempt to use the ScreenGrabber API failed validation.",
    "A decoy 200 success response was returned to avoid giving hints to the caller.",
    "",
    `Timestamp: ${logEntry.timestamp}`,
    `Endpoint: ${logEntry.method} ${logEntry.endpoint}`,
    `Reason: ${logEntry.reason}`,
    `All reasons: ${logEntry.reasons.join(", ")}`,
    `App ID: ${logEntry.appId || "(none)"}`,
    `Origin: ${logEntry.origin || "(none)"}`,
    `Client IP: ${logEntry.ip}`,
    `IP Hash: ${logEntry.ipHash || "(none)"}`,
    `User-Agent: ${logEntry.userAgent || "(none)"}`,
    `Page URL: ${logEntry.pageUrl || "(none)"}`,
    `Private AWS S3 Log: s3://${logEntry.bucket}/${logEntry.logKey}`,
    "",
    "Log payload:",
    JSON.stringify(logEntry, null, 2),
  ].join("\n");

  const payload = JSON.stringify({
    FromEmailAddress: fromEmail,
    Destination: {
      ToAddresses: [toEmail],
    },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: textBody, Charset: "UTF-8" },
        },
      },
    },
  });

  const hostname = `email.${region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const credentials = await resolveCredentials();
  const signer = new SignatureV4({
    service: "ses",
    region,
    credentials,
    sha256: Sha256,
  });

  const signed = await signer.sign({
    method: "POST",
    protocol: "https:",
    hostname,
    path,
    headers: {
      host: hostname,
      "content-type": "application/json",
    },
    body: payload,
  });

  if (process.env.NODE_TEST_CONTEXT && globalThis.fetch === nativeFetch) {
    return { sent: false, skippedInTest: true, toEmail, subject };
  }

  const res = await globalThis.fetch(`https://${hostname}${path}`, {
    method: "POST",
    headers: signed.headers,
    body: payload,
  });

  return { sent: !!(res && (res.ok ?? true)), toEmail, subject };
}

export async function recordFailedAttempt({
  s3,
  env,
  endpoint,
  method = "POST",
  reason,
  reasons,
  appId,
  origin,
  ip,
  ipHash,
  userAgent,
  pageUrl,
  details = {},
}) {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const datePart = timestamp.slice(0, 10);
  const prefix = String(env.FAILED_LOG_PREFIX || DEFAULT_LOG_PREFIX).replace(
    /^\/+|\/+$/g,
    ""
  );
  const logKey = `${prefix}/${datePart}/${now}-${id}.json`;
  const alertEmail = env.ALERT_EMAIL || DEFAULT_ALERT_EMAIL;

  const logEntry = {
    id,
    timestamp,
    createdAt: now,
    endpoint,
    method,
    reason,
    reasons: Array.isArray(reasons) && reasons.length ? reasons : [reason],
    appId: appId || null,
    origin: origin || null,
    ip: ip || "unknown",
    ipHash: ipHash || null,
    userAgent: userAgent || null,
    pageUrl: pageUrl || null,
    bucket: env.BUCKET,
    logKey,
    alertEmail,
    details,
  };

  if (!process.env.NODE_TEST_CONTEXT || env.VERBOSE_TEST_LOGS === "1") {
    console.warn(
      JSON.stringify({
        level: "warn",
        type: "failed_validation_attempt",
        ...logEntry,
      })
    );
  }

  let storedInS3 = false;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.BUCKET,
        Key: logKey,
        Body: JSON.stringify(logEntry, null, 2),
        ContentType: "application/json",
      })
    );
    storedInS3 = true;
  } catch (err) {
    if (!process.env.NODE_TEST_CONTEXT) {
      console.error("Failed to store private validation log in S3:", err);
    }
  }

  let emailSent = false;
  try {
    const res = await sendFailureEmail(env, logEntry);
    emailSent = !!res.sent;
  } catch (err) {
    if (!process.env.NODE_TEST_CONTEXT) {
      console.error("Failed to send validation alert email:", err);
    }
  }

  return { logEntry, logKey, storedInS3, emailSent };
}

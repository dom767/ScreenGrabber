/**
 * Baffled Cat shared screenshots client (ESM).
 *
 * Usage:
 *   import { createBaffledScreenshots } from "./baffled-screenshots.js";
 *   const shots = createBaffledScreenshots({ apiBase, appId, turnstileSiteKey });
 *   await shots.upload({ imageBlob, thumbBlob, pageUrl, meta });
 */

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * @param {object} opts
 * @param {string} opts.apiBase e.g. https://shots.baffledcat.com
 * @param {string} opts.appId e.g. mandelbrot
 * @param {string} [opts.turnstileSiteKey]
 * @param {boolean} [opts.devBypassTurnstile] when API has DEV_BYPASS_TURNSTILE=1
 */
export function createBaffledScreenshots(opts) {
  const apiBase = String(opts.apiBase || "").replace(/\/+$/, "");
  const appId = String(opts.appId || "");
  const turnstileSiteKey = opts.turnstileSiteKey || "";
  const devBypassTurnstile = !!opts.devBypassTurnstile;

  if (!apiBase) throw new Error("apiBase required");
  if (!appId) throw new Error("appId required");

  let turnstileReady = null;
  let widgetId = null;
  let hostEl = null;

  async function ensureTurnstile() {
    if (devBypassTurnstile || !turnstileSiteKey) return;
    if (window.turnstile) return;
    if (!turnstileReady) {
      turnstileReady = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = TURNSTILE_SRC;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error("Turnstile failed to load"));
        document.head.appendChild(s);
      });
    }
    await turnstileReady;
  }

  async function getTurnstileToken() {
    if (devBypassTurnstile || !turnstileSiteKey) return "dev-bypass";
    await ensureTurnstile();
    if (!hostEl) {
      hostEl = document.createElement("div");
      hostEl.style.cssText =
        "position:fixed;left:-9999px;width:1px;height:1px;overflow:hidden;";
      document.body.appendChild(hostEl);
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Turnstile timeout")),
        30000
      );
      try {
        if (widgetId != null && window.turnstile) {
          window.turnstile.reset(widgetId);
        }
        widgetId = window.turnstile.render(hostEl, {
          sitekey: turnstileSiteKey,
          size: "invisible",
          callback: (token) => {
            clearTimeout(timeout);
            resolve(token);
          },
          "error-callback": () => {
            clearTimeout(timeout);
            reject(new Error("Turnstile error"));
          },
        });
        window.turnstile.execute(widgetId);
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  }

  async function sha256Hex(blob) {
    const buf = await blob.arrayBuffer();
    const dig = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(dig)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * @param {object} args
   * @param {Blob} args.imageBlob share JPEG (≤1080p)
   * @param {Blob} args.thumbBlob square JPEG 256
   * @param {string} [args.pageUrl]
   * @param {object} [args.meta]
   * @param {string} [args.title]
   * @param {string} [args.note]
   */
  async function upload(args) {
    const imageBlob = args.imageBlob;
    const thumbBlob = args.thumbBlob;
    if (!(imageBlob instanceof Blob) || !(thumbBlob instanceof Blob)) {
      throw new Error("imageBlob and thumbBlob required");
    }

    const contentSha256 = await sha256Hex(imageBlob);
    const turnstileToken = await getTurnstileToken();

    const ticketRes = await fetch(`${apiBase}/v1/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId,
        bytes: imageBlob.size,
        contentSha256,
        turnstileToken,
      }),
    });
    const ticketData = await ticketRes.json().catch(() => ({}));
    if (!ticketRes.ok) {
      throw new Error(ticketData.error || "ticket failed");
    }

    const form = new FormData();
    form.set("ticket", ticketData.ticket);
    form.set("appId", appId);
    form.set("image", imageBlob, "shot.jpg");
    form.set("thumb", thumbBlob, "thumb.jpg");
    if (args.pageUrl) form.set("pageUrl", args.pageUrl);
    if (args.title) form.set("title", args.title);
    if (args.note) form.set("note", args.note);
    if (args.meta != null) form.set("meta", JSON.stringify(args.meta));

    const upRes = await fetch(`${apiBase}/v1/shots`, {
      method: "POST",
      body: form,
    });
    const upData = await upRes.json().catch(() => ({}));
    if (!upRes.ok) throw new Error(upData.error || "upload failed");
    return upData;
  }

  /**
   * @param {object} [q]
   * @param {number} [q.limit]
   * @param {string} [q.cursor]
   * @param {string} [q.appId] defaults to configured appId
   */
  async function list(q = {}) {
    const params = new URLSearchParams();
    params.set("app_id", q.appId || appId);
    if (q.limit) params.set("limit", String(q.limit));
    if (q.cursor) params.set("cursor", q.cursor);
    const res = await fetch(`${apiBase}/v1/shots?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "list failed");
    return data;
  }

  async function get(id) {
    const res = await fetch(`${apiBase}/v1/shots/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "get failed");
    return data.shot;
  }

  return { upload, list, get, apiBase, appId };
}

export default createBaffledScreenshots;

/**
 * Minimal image header sniff + JPEG/PNG/WebP dimension parse.
 */

const JPEG = "image/jpeg";
const PNG = "image/png";
const WEBP = "image/webp";

export function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return JPEG;
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return PNG;
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return WEBP;
  }
  return null;
}

export function readDimensions(buf, mime) {
  if (mime === JPEG) return readJpegSize(buf);
  if (mime === PNG) return readPngSize(buf);
  if (mime === WEBP) return readWebpSize(buf);
  return null;
}

function readPngSize(buf) {
  if (buf.length < 24) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function readJpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (len < 2) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const height = (buf[i + 5] << 8) | buf[i + 6];
      const width = (buf[i + 7] << 8) | buf[i + 8];
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

function readWebpSize(buf) {
  if (buf.length < 30) return null;
  if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
    if (buf.length < 30) return null;
    const w = buf[26] | ((buf[27] & 0x3f) << 8);
    const h = buf[28] | ((buf[29] & 0x3f) << 8);
    return { width: w, height: h };
  }
  if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c) {
    if (buf.length < 25) return null;
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const w = 1 + (((b1 & 0x3f) << 8) | b0);
    const h = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width: w, height: h };
  }
  return null;
}

export function validateImageBytes(buf, env, { expectSquare = false } = {}) {
  const maxBytes = Number(env.MAX_UPLOAD_BYTES || 2_097_152);
  const maxEdge = Number(env.MAX_EDGE || 1920);
  const thumbEdge = Number(env.THUMB_EDGE || 256);

  if (!(buf instanceof Uint8Array) || buf.length < 24) {
    return { ok: false, error: "empty image" };
  }
  if (buf.length > maxBytes) {
    return { ok: false, error: "image too large" };
  }

  const mime = sniffMime(buf);
  if (!mime) return { ok: false, error: "unsupported image type" };

  const dim = readDimensions(buf, mime);
  if (!dim || !dim.width || !dim.height) {
    return { ok: false, error: "could not read dimensions" };
  }

  if (expectSquare) {
    if (dim.width !== dim.height) {
      return { ok: false, error: "thumb must be square" };
    }
    if (dim.width !== thumbEdge) {
      return { ok: false, error: `thumb must be ${thumbEdge}px` };
    }
  } else if (dim.width > 1920 || dim.height > 1080 || dim.width > maxEdge) {
    return { ok: false, error: "exceeds 1920×1080" };
  }

  return { ok: true, mime, width: dim.width, height: dim.height, bytes: buf.length };
}

export async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

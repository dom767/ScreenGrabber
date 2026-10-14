/**
 * Minimal multipart/form-data parser for Lambda (Buffer body).
 * Returns { fields: Record<string,string>, files: Record<string,{ filename, mime, data: Buffer }> }
 */

export function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("missing multipart boundary");
  const boundary = m[1] || m[2];
  const sep = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};

  let start = indexOf(body, sep, 0);
  if (start < 0) return { fields, files };
  start += sep.length;
  if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;

  while (start < body.length) {
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // --
    const next = indexOf(body, sep, start);
    const end = next < 0 ? body.length : next;
    let part = body.subarray(start, end);
    // trim trailing CRLF before boundary
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = indexOf(part, Buffer.from("\r\n\r\n"), 0);
    if (headerEnd < 0) {
      start = next < 0 ? body.length : next + sep.length;
      if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
      continue;
    }
    const headerText = part.subarray(0, headerEnd).toString("utf8");
    const data = part.subarray(headerEnd + 4);
    const nameMatch = /name="([^"]+)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const name = nameMatch ? nameMatch[1] : null;
    if (name) {
      if (fileMatch) {
        files[name] = {
          filename: fileMatch[1] || "file",
          mime: (typeMatch && typeMatch[1].trim()) || "application/octet-stream",
          data: Buffer.from(data),
        };
      } else {
        fields[name] = data.toString("utf8");
      }
    }

    if (next < 0) break;
    start = next + sep.length;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  }

  return { fields, files };
}

function indexOf(buf, needle, from) {
  outer: for (let i = from; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

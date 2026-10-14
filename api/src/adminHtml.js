export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Baffled Cat Shots — Admin</title>
  <style>
    :root { color-scheme: dark; --bg:#1c1812; --fg:#f6efe2; --muted:#b3a68e; --amber:#f2a544; --border:rgba(246,239,226,.12); }
    * { box-sizing: border-box; }
    body { margin:0; font-family: system-ui, sans-serif; background:var(--bg); color:var(--fg); padding:1.25rem; }
    h1 { font-size:1.25rem; margin:0 0 1rem; }
    .row { display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; margin-bottom:1rem; }
    input, select, button { font:inherit; padding:.45rem .65rem; border-radius:8px; border:1px solid var(--border); background:#262019; color:var(--fg); }
    button { cursor:pointer; background:var(--amber); color:#1c1812; border:none; font-weight:600; }
    button.secondary { background:transparent; color:var(--fg); border:1px solid var(--border); }
    button.danger { background:#a33; color:#fff; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:1rem; }
    .card { border:1px solid var(--border); border-radius:12px; overflow:hidden; background:#262019; }
    .card img { width:100%; aspect-ratio:1; object-fit:cover; display:block; background:#111; cursor:zoom-in; }
    .card .meta { padding:.65rem; font-size:.75rem; color:var(--muted); display:flex; flex-direction:column; gap:.35rem; }
    .card .meta a { color:var(--amber); word-break:break-all; }
    .actions { display:flex; gap:.35rem; flex-wrap:wrap; }
    .hidden { display:none !important; }
    #login { max-width:22rem; }
    .err { color:#f88; font-size:.85rem; }
    #lightbox {
      position:fixed; inset:0; z-index:50;
      display:flex; align-items:center; justify-content:center;
      padding:1.25rem; background:rgba(12,10,8,.82);
      backdrop-filter:blur(4px);
    }
    #lightbox.hidden { display:none !important; }
    .lightbox__panel {
      position:relative; max-width:min(96vw, 1400px); max-height:92vh;
      display:flex; flex-direction:column; gap:.75rem;
      background:#262019; border:1px solid var(--border); border-radius:14px;
      padding:.85rem; box-shadow:0 18px 48px rgba(0,0,0,.45);
    }
    .lightbox__head {
      display:flex; align-items:center; justify-content:space-between; gap:.75rem;
      color:var(--muted); font-size:.8rem;
    }
    .lightbox__close {
      flex:0 0 auto; width:2rem; height:2rem; padding:0; border-radius:999px;
      background:transparent; color:var(--fg); border:1px solid var(--border); font-size:1.25rem; line-height:1;
    }
    .lightbox__img-wrap {
      overflow:auto; max-height:calc(92vh - 4.5rem);
      border-radius:8px; background:#111;
    }
    .lightbox__img-wrap img {
      display:block; max-width:100%; height:auto; margin:0 auto;
    }
  </style>
</head>
<body>
  <h1>Screenshot admin</h1>
  <section id="login">
    <div class="row">
      <input id="token" type="password" placeholder="Admin token" style="flex:1" />
      <button id="login-btn" type="button">Unlock</button>
    </div>
    <p class="err hidden" id="login-err"></p>
  </section>
  <section id="panel" class="hidden">
    <div class="row">
      <select id="app">
        <option value="">All apps</option>
        <option value="mandelbrot">mandelbrot</option>
      </select>
      <select id="status">
        <option value="all">All statuses</option>
        <option value="approved">approved</option>
        <option value="hidden">hidden</option>
        <option value="pending">pending</option>
      </select>
      <button id="refresh" type="button" class="secondary">Refresh</button>
      <button id="logout" type="button" class="secondary">Lock</button>
    </div>
    <div class="grid" id="grid"></div>
    <p class="err" id="list-err"></p>
  </section>
  <div id="lightbox" class="hidden" role="dialog" aria-modal="true" aria-label="Full resolution screenshot">
    <div class="lightbox__panel">
      <div class="lightbox__head">
        <span id="lightbox-caption"></span>
        <button type="button" class="lightbox__close" id="lightbox-close" aria-label="Close">&times;</button>
      </div>
      <div class="lightbox__img-wrap">
        <img id="lightbox-img" alt="Full resolution screenshot" />
      </div>
    </div>
  </div>
  <script>
    const apiBase = location.origin;
    const tokenKey = "bc_shots_admin";
    const $ = (id) => document.getElementById(id);

    function token() { return sessionStorage.getItem(tokenKey) || ""; }

    async function api(path, opts = {}) {
      const headers = Object.assign({}, opts.headers || {});
      if (token()) headers.Authorization = "Bearer " + token();
      const res = await fetch(apiBase + path, { ...opts, headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function showPanel(on) {
      $("login").classList.toggle("hidden", on);
      $("panel").classList.toggle("hidden", !on);
    }

    $("login-btn").onclick = async () => {
      sessionStorage.setItem(tokenKey, $("token").value.trim());
      try {
        await api("/v1/admin/shots?limit=1");
        $("login-err").classList.add("hidden");
        showPanel(true);
        load();
      } catch (e) {
        sessionStorage.removeItem(tokenKey);
        $("login-err").textContent = e.message;
        $("login-err").classList.remove("hidden");
      }
    };

    $("logout").onclick = () => { sessionStorage.removeItem(tokenKey); showPanel(false); closeLightbox(); };
    $("refresh").onclick = () => load();
    $("app").onchange = () => load();
    $("status").onchange = () => load();

    function openLightbox(shot) {
      const img = $("lightbox-img");
      img.removeAttribute("src");
      img.src = shot.imageUrl;
      $("lightbox-caption").textContent =
        (shot.appId || "") + " · " + (shot.width || "?") + "×" + (shot.height || "?") +
        (shot.status ? " · " + shot.status : "");
      $("lightbox").classList.remove("hidden");
      document.body.style.overflow = "hidden";
    }

    function closeLightbox() {
      $("lightbox").classList.add("hidden");
      $("lightbox-img").removeAttribute("src");
      document.body.style.overflow = "";
    }

    $("lightbox-close").onclick = (e) => { e.stopPropagation(); closeLightbox(); };
    $("lightbox").onclick = (e) => { if (e.target === $("lightbox")) closeLightbox(); };
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("lightbox").classList.contains("hidden")) closeLightbox();
    });

    async function load() {
      $("list-err").textContent = "";
      const q = new URLSearchParams();
      q.set("limit", "100");
      if ($("app").value) q.set("app_id", $("app").value);
      if ($("status").value) q.set("status", $("status").value);
      try {
        const data = await api("/v1/admin/shots?" + q);
        const grid = $("grid");
        grid.innerHTML = "";
        for (const s of data.shots || []) {
          const card = document.createElement("article");
          card.className = "card";
          const when = new Date(s.createdAt).toLocaleString();
          card.innerHTML = \`
            <img src="\${s.thumbUrl}" alt="" loading="lazy" data-act="preview" />
            <div class="meta">
              <div><strong>\${s.appId}</strong> · \${s.status}</div>
              <div>\${when}</div>
              <div>\${s.width}×\${s.height}</div>
              \${s.pageUrl ? \`<a href="\${s.pageUrl}" target="_blank" rel="noopener">Open view</a>\` : ""}
              <div class="actions">
                <button type="button" class="secondary" data-act="hide">Hide</button>
                <button type="button" class="secondary" data-act="approve">Approve</button>
                <button type="button" class="danger" data-act="delete">Delete</button>
              </div>
            </div>\`;
          card.querySelector('[data-act="preview"]').onclick = () => openLightbox(s);
          card.querySelector('[data-act="hide"]').onclick = () => patch(s.id, "hidden");
          card.querySelector('[data-act="approve"]').onclick = () => patch(s.id, "approved");
          card.querySelector('[data-act="delete"]').onclick = () => hardDelete(s.id);
          grid.appendChild(card);
        }
      } catch (e) {
        $("list-err").textContent = e.message;
      }
    }

    async function patch(id, status) {
      await api("/v1/admin/shots/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      load();
    }

    async function hardDelete(id) {
      if (!confirm("Permanently delete this shot and its files?")) return;
      await api("/v1/admin/shots/" + id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "hidden", hardDelete: true }),
      });
      load();
    }

    if (token()) {
      showPanel(true);
      load();
    }
  </script>
</body>
</html>
`;

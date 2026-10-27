# Take Screenshot GUI Specification

Standard specification for the **"Take Screenshot"** capture panel across baffledcat.com applications. Consumer apps (e.g. `MandelbrotViewer`, `BifurcationDiagram`, `Highpersonic3`) should follow this guide when building their screenshot GUI so every app shares a consistent look, feel, and workflow.

For the underlying upload and gallery SDK contract, see [`README.md`](README.md) and [`sdk/baffled-screenshots.js`](sdk/baffled-screenshots.js). For Baffled Cat visual tokens and typography rules, see `guidelines/style.md` and `design/tokens.css` in the standards repository.

---

## 1. User Workflow

1. **Trigger ("Take Screenshot"):**
   - Clicking the **"Take Screenshot"** button in the application's toolbar/menu (or pressing the app's screenshot shortcut, e.g. `Ctrl+S` if wired to the panel) opens the **Take Screenshot** panel rather than immediately downloading or uploading a file.
   - When the panel opens, the application captures the current frame (or freezes/reads from the active canvas) into an offscreen working source so the user can preview adjustments before saving.

2. **Configure Options in Panel:**
   - **Live preview:** Displays how the captured image will look with the current brightness and contrast adjustments applied.
   - **Brightness slider:** Adjusts output image brightness (`-100` to `+100`, default `0`, or `50%` to `150%`, default `100%`).
   - **Contrast slider:** Adjusts output image contrast (`-100` to `+100`, default `0`, or `50%` to `150%`, default `100%`).
   - **Upload checkbox:** A checkbox labeled **"Upload to baffledcat.com"** (checked or unchecked per app default; unchecked by default unless the app specifies otherwise, or persisted in `localStorage` if desired).

3. **Capture Action ("Capture"):**
   - Clicking the primary **"Capture"** button produces the final adjusted image (with brightness and contrast baked into the exported pixels):
     1. **Always triggers a local download** of the adjusted screenshot (e.g. `<app-id>-<timestamp>.jpg`).
     2. **Optionally uploads to `shots.baffledcat.com`** if **"Upload to baffledcat.com"** is checked, using the ScreenGrabber SDK (`shots.upload({ imageBlob, thumbBlob, pageUrl, meta })`).
   - While capturing/uploading, disable the **Capture** button and show status feedback (`"Capturing…"` / `"Uploading…"`). On completion, show brief confirmation or close the panel. If the upload fails, report the error clearly inside the panel without blocking the local file download.

4. **Dismiss / Cancel:**
   - The user can close the panel without capturing via a **Close (`×`)** or **Cancel** button, pressing `Escape`, or clicking the backdrop (if presented as a modal dialog).

---

## 2. Panel Controls & Defaults

| Control | Element | Label / Text | Range / Default | Behaviour |
| --- | --- | --- | --- | --- |
| **Heading** | `<h2>` | `Take screenshot` | Sentence case | Identifies the panel (`aria-labelledby`) |
| **Preview** | `<canvas>` or `<img>` | — | 16:9 or canvas aspect | Shows live brightness/contrast effect |
| **Brightness** | `<input type="range">` | `BRIGHTNESS` | `50` to `150`, step `1`, default `100` (`100%`) | Scales pixel brightness; displays current value (`100%` or `+0`) |
| **Contrast** | `<input type="range">` | `CONTRAST` | `50` to `150`, step `1`, default `100` (`100%`) | Scales pixel contrast; displays current value (`100%` or `+0`) |
| **Reset** *(optional)* | `<button type="button">` | `Reset` | Ghost/secondary button | Resets brightness and contrast to `100%` |
| **Upload toggle** | `<input type="checkbox">` | `Upload to baffledcat.com` | Unchecked by default (or app default) | When checked, **Capture** also uploads via ScreenGrabber SDK |
| **Cancel / Close** | `<button type="button">` | `Cancel` / `×` | Secondary pill button | Closes the panel without downloading or uploading |
| **Primary action** | `<button type="button">` | `Capture` | Primary amber pill button | Triggers local download and (if checked) upload to `baffledcat.com` |

---

## 3. Look and Feel (Baffled Cat Design Tokens)

Use the standard tokens from `design/tokens.css` (`color-scheme: dark`). Never hard-code colours, fonts, or radii that have tokens.

- **Surface & Borders:**
  - Panel background: `var(--bg-raised)` (`#262019`)
  - Border: `1px solid var(--border)` (`rgba(246, 239, 226, 0.1)`)
  - Radius: `var(--radius)` (`14px`) for the panel; `var(--radius-sm)` (`9px`) for the preview frame
  - Backdrop (when modal): `rgba(12, 10, 8, 0.78)` with `backdrop-filter: blur(4px)`
- **Typography & Capitalisation:**
  - Panel title (`Take screenshot`): `var(--font-display)`, sentence case, `var(--text)`, tight tracking (`-0.01em`).
  - Slider eyebrows/labels (`BRIGHTNESS`, `CONTRAST`): `var(--font-mono)`, `text-transform: uppercase`, `letter-spacing: 0.06em`, `var(--text-faint-on-raised)` (`#a89a7c`, preserving ≥ 4.5:1 contrast on `--bg-raised`).
  - Checkbox label (`Upload to baffledcat.com`) and status copy: `var(--font-body)`, `var(--text)` (or `var(--text-muted)` for secondary notes), sentence case as written.
- **Accents & Interactive Controls:**
  - Primary **Capture** button: pill shape (`border-radius: var(--radius-pill)` / `999px`), `background: var(--accent-amber)`, text `#1c1812` (`var(--bg)`), `font-family: var(--font-display)`, `font-weight: 600`. Lifts `translateY(-1px)` on hover (`transition: var(--transition)`).
  - Secondary **Cancel** / **Reset** buttons: pill shape, `background: transparent`, `color: var(--text)`, `border: 1px solid var(--border-strong)`. Hover brightens border to `var(--accent-amber)`.
  - Sliders & Checkbox: `accent-color: var(--accent-amber)`.
  - Focus ring: visible `:focus-visible` outline in `var(--accent-amber)`.
  - Respect `prefers-reduced-motion: reduce`.

---

## 4. Reference Markup

Apps may mount the panel either as a native `<dialog>` modal or an anchored floating panel in the app chrome. Below is the recommended accessible structure:

```html
<!-- Trigger button in the app toolbar -->
<button type="button" class="bc-btn bc-btn--secondary" id="take-screenshot-btn">
  Take Screenshot
</button>

<!-- Take Screenshot Panel -->
<dialog id="screenshot-panel" class="bc-shot-dialog" aria-labelledby="screenshot-panel-title">
  <form method="dialog" class="bc-shot-panel" id="screenshot-form">
    <header class="bc-shot-panel__head">
      <h2 id="screenshot-panel-title" class="bc-shot-panel__title">Take screenshot</h2>
      <button type="button" class="bc-shot-panel__close" id="screenshot-close-btn" aria-label="Close">
        &times;
      </button>
    </header>

    <div class="bc-shot-panel__preview-wrap">
      <canvas id="screenshot-preview" class="bc-shot-panel__preview" width="480" height="270"></canvas>
    </div>

    <div class="bc-shot-panel__controls">
      <div class="bc-shot-field">
        <div class="bc-shot-field__label-row">
          <label for="screenshot-brightness" class="bc-shot-field__label">Brightness</label>
          <output for="screenshot-brightness" id="screenshot-brightness-val" class="bc-shot-field__value">100%</output>
        </div>
        <input
          type="range"
          id="screenshot-brightness"
          min="50"
          max="150"
          step="1"
          value="100"
        />
      </div>

      <div class="bc-shot-field">
        <div class="bc-shot-field__label-row">
          <label for="screenshot-contrast" class="bc-shot-field__label">Contrast</label>
          <output for="screenshot-contrast" id="screenshot-contrast-val" class="bc-shot-field__value">100%</output>
        </div>
        <input
          type="range"
          id="screenshot-contrast"
          min="50"
          max="150"
          step="1"
          value="100"
        />
      </div>

      <label class="bc-shot-checkbox">
        <input type="checkbox" id="screenshot-upload-check" />
        <span>Upload to baffledcat.com</span>
      </label>
    </div>

    <p id="screenshot-status" class="bc-shot-panel__status" role="status" aria-live="polite" hidden></p>

    <footer class="bc-shot-panel__actions">
      <button type="button" class="bc-btn bc-btn--secondary" id="screenshot-reset-btn">
        Reset
      </button>
      <div class="bc-shot-panel__actions-right">
        <button type="button" class="bc-btn bc-btn--secondary" id="screenshot-cancel-btn">
          Cancel
        </button>
        <button type="button" class="bc-btn bc-btn--primary" id="screenshot-capture-btn">
          Capture
        </button>
      </div>
    </footer>
  </form>
</dialog>
```

---

## 5. Reference CSS

Requires `design/tokens.css` loaded beforehand.

```css
.bc-shot-dialog {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-raised);
  color: var(--text);
  max-width: min(92vw, 26rem);
  width: 100%;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}

.bc-shot-dialog::backdrop {
  background: rgba(12, 10, 8, 0.78);
  backdrop-filter: blur(4px);
}

.bc-shot-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.15rem;
  font-family: var(--font-body);
}

.bc-shot-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.bc-shot-panel__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}

.bc-shot-panel__close {
  width: 2rem;
  height: 2rem;
  padding: 0;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  transition: color var(--transition), border-color var(--transition), transform var(--transition);
}

.bc-shot-panel__close:hover {
  color: var(--text);
  border-color: var(--accent-amber);
  transform: translateY(-1px);
}

.bc-shot-panel__preview-wrap {
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg);
}

.bc-shot-panel__preview {
  display: block;
  width: 100%;
  height: auto;
}

.bc-shot-panel__controls {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}

.bc-shot-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.bc-shot-field__label-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint-on-raised);
}

.bc-shot-field input[type="range"] {
  width: 100%;
  accent-color: var(--accent-amber);
  cursor: pointer;
}

.bc-shot-checkbox {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.925rem;
  color: var(--text);
  cursor: pointer;
  user-select: none;
  margin-top: 0.15rem;
}

.bc-shot-checkbox input[type="checkbox"] {
  width: 1.05rem;
  height: 1.05rem;
  accent-color: var(--accent-amber);
  cursor: pointer;
}

.bc-shot-panel__status {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.bc-shot-panel__status[data-error="true"] {
  color: var(--accent-amber);
}

.bc-shot-panel__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.bc-shot-panel__actions-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.bc-btn {
  font-family: var(--font-display);
  font-size: 0.9rem;
  font-weight: 600;
  padding: 0.5rem 1rem;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: background var(--transition), color var(--transition), border-color var(--transition), transform var(--transition);
}

.bc-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.bc-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.bc-btn--primary {
  background: var(--accent-amber);
  color: var(--bg);
  border: 1px solid transparent;
}

.bc-btn--secondary {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--border-strong);
}

.bc-btn--secondary:hover:not(:disabled) {
  border-color: var(--accent-amber);
}

.bc-shot-dialog :focus-visible {
  outline: 2px solid var(--accent-amber);
  outline-offset: 2px;
}
```

---

## 6. Image Processing, Download & Upload Pipeline

When **Capture** is clicked, both the local download and the optional `baffledcat.com` upload must include the user's brightness and contrast adjustments.

### Applying Brightness and Contrast

Render the captured frame onto an offscreen `<canvas>` with 2D context filters (or per-pixel math if `ctx.filter` is unavailable):

```js
/**
 * Render sourceCanvas with brightness/contrast applied, fitted within maxW × maxH.
 * @param {HTMLCanvasElement|HTMLImageElement|ImageBitmap} source
 * @param {object} opts
 * @param {number} opts.brightness percentage (50..150, default 100)
 * @param {number} opts.contrast percentage (50..150, default 100)
 * @param {number} [opts.maxWidth=1920]
 * @param {number} [opts.maxHeight=1080]
 * @returns {HTMLCanvasElement}
 */
export function renderAdjustedCanvas(source, {
  brightness = 100,
  contrast = 100,
  maxWidth = 1920,
  maxHeight = 1080,
} = {}) {
  const srcW = source.width || source.videoWidth;
  const srcH = source.height || source.videoHeight;
  const scale = Math.min(1, maxWidth / srcW, maxHeight / srcH);
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));

  const out = document.createElement("canvas");
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext("2d");

  ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  ctx.drawImage(source, 0, 0, outW, outH);
  ctx.filter = "none";
  return out;
}
```

### Creating the 256×256 Thumbnail (Center-Cropped Square)

ScreenGrabber requires a **256×256 JPEG** `thumbBlob` alongside the main `imageBlob` (which must fit within **1920×1080** and **≤ 2 MiB**):

```js
export function renderSquareThumbCanvas(adjustedCanvas, size = 256) {
  const thumb = document.createElement("canvas");
  thumb.width = size;
  thumb.height = size;
  const ctx = thumb.getContext("2d");

  const srcW = adjustedCanvas.width;
  const srcH = adjustedCanvas.height;
  const side = Math.min(srcW, srcH);
  const sx = Math.round((srcW - side) / 2);
  const sy = Math.round((srcH - side) / 2);

  ctx.drawImage(adjustedCanvas, sx, sy, side, side, 0, 0, size, size);
  return thumb;
}

export function canvasToJpegBlob(canvas, quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Canvas export failed"))),
      "image/jpeg",
      quality
    );
  });
}
```

### Handling the "Capture" Button Click

```js
async function onCaptureClick({
  sourceCanvas,
  brightness,
  contrast,
  shouldUpload,
  appId,
  shotsClient,
  getMeta,
}) {
  // 1. Render adjusted image (capped at 1920x1080 for ScreenGrabber compatibility)
  const adjustedCanvas = renderAdjustedCanvas(sourceCanvas, {
    brightness,
    contrast,
    maxWidth: 1920,
    maxHeight: 1080,
  });

  // 2. Encode JPEG (quality 0.85; drop to 0.70 if > 2 MiB)
  let imageBlob = await canvasToJpegBlob(adjustedCanvas, 0.85);
  if (imageBlob.size > 2 * 1024 * 1024) {
    imageBlob = await canvasToJpegBlob(adjustedCanvas, 0.7);
  }

  // 3. Trigger local browser download
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${appId}-${stamp}.jpg`;
  const url = URL.createObjectURL(imageBlob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 4. Optionally upload to baffledcat.com if checkbox is checked
  if (shouldUpload && shotsClient) {
    const thumbCanvas = renderSquareThumbCanvas(adjustedCanvas, 256);
    const thumbBlob = await canvasToJpegBlob(thumbCanvas, 0.8);
    await shotsClient.upload({
      imageBlob,
      thumbBlob,
      pageUrl: window.location.href,
      meta: typeof getMeta === "function" ? getMeta() : undefined,
    });
  }
}
```

---

## 7. WebGL / WebGPU Canvas Notes

- When capturing from a WebGL or WebGPU canvas without `preserveDrawingBuffer: true`, read the canvas on the **same animation frame** (immediately after rendering) into an offscreen 2D `<canvas>` when the user clicks **"Take Screenshot"**.
- Store that snapshot canvas while the **Take Screenshot** panel is open so adjusting the **Brightness** and **Contrast** sliders updates the preview immediately without needing the main simulation loop to re-render.

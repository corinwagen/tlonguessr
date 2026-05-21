import {
  ATLAS_HEIGHT_KM,
  ATLAS_WIDTH_KM,
  DAILY_RESULT_PREFIX,
  DEFAULT_IMAGE_LIBRARY,
  MAP_ASSET_URL,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_POINTS_PER_ROUND,
  ROUND_COUNT,
  ROUND_SECONDS,
  SCORE_DECAY_KM,
  STORAGE_KEY,
} from "./library.js";

const app = document.getElementById("app");

const state = {
  route: new URLSearchParams(window.location.search).has("admin") ? "admin" : "play",
  library: loadLibrary(),
  dailyKey: utcDayKey(),
  dailyResult: loadDailyResult(utcDayKey()),
  phase: "idle",
  session: [],
  roundIndex: 0,
  guess: null,
  scores: [],
  deadline: 0,
  remaining: ROUND_SECONDS,
  timerId: null,
  selectedId: null,
  exportText: "",
  mapViews: {
    player: fullMapView(),
    admin: fullMapView(),
  },
};

function fullMapView() {
  return { x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT };
}

function loadLibrary() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return clone(DEFAULT_IMAGE_LIBRARY);

  try {
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) throw new Error("Library must be an array.");
    return mergeLibraryDefaults(normalizeLibrary(parsed));
  } catch (error) {
    console.warn("Ignoring invalid saved image library.", error);
    return clone(DEFAULT_IMAGE_LIBRARY);
  }
}

function mergeLibraryDefaults(library) {
  const existing = new Set(library.flatMap((image) => [image.id, image.src]));
  const missing = DEFAULT_IMAGE_LIBRARY.filter((image) => !existing.has(image.id) && !existing.has(image.src));
  return [...library, ...clone(missing)];
}

function normalizeLibrary(records) {
  return records
    .filter((record) => record && typeof record.src === "string")
    .map((record, index) => ({
      id: String(record.id || filenameId(record.src) || `image-${index + 1}`),
      title: String(record.title || titleFromPath(record.src)),
      src: String(record.src),
      coord: {
        x: clamp01(Number(record.coord?.x ?? 0.5)),
        y: clamp01(Number(record.coord?.y ?? 0.5)),
      },
      active: record.active !== false,
      notes: String(record.notes || ""),
    }));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function saveLibrary(library = state.library) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
}

function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function dailyResultKey(dayKey = state.dailyKey) {
  return `${DAILY_RESULT_PREFIX}${dayKey}`;
}

function loadDailyResult(dayKey) {
  const saved = localStorage.getItem(`${DAILY_RESULT_PREFIX}${dayKey}`);
  if (!saved) return null;

  try {
    const parsed = JSON.parse(saved);
    if (!parsed || !Array.isArray(parsed.scores)) return null;
    return {
      ...parsed,
      total: Number(parsed.total ?? parsed.scores.reduce((sum, score) => sum + Number(score.points || 0), 0)),
      maxTotal: Number(parsed.maxTotal ?? parsed.scores.length * MAX_POINTS_PER_ROUND),
    };
  } catch (error) {
    console.warn("Ignoring invalid saved daily result.", error);
    return null;
  }
}

function saveDailyResult() {
  const total = state.scores.reduce((sum, score) => sum + score.points, 0);
  const result = {
    dayKey: state.dailyKey,
    completedAt: new Date().toISOString(),
    scores: state.scores,
    total,
    maxTotal: state.scores.length * MAX_POINTS_PER_ROUND,
  };
  localStorage.setItem(dailyResultKey(), JSON.stringify(result));
  state.dailyResult = result;
  return result;
}

function setRoute(route) {
  state.route = route;
  const url = route === "admin" ? "?admin" : window.location.pathname;
  history.replaceState(null, "", url);
  stopTimer();
  if (route === "play" && state.phase !== "idle" && state.phase !== "final") {
    state.phase = "idle";
  }
  render();
}

function startGame() {
  state.dailyKey = utcDayKey();
  state.dailyResult = loadDailyResult(state.dailyKey);
  if (state.dailyResult) {
    state.phase = "dailyComplete";
    render();
    return;
  }

  const active = state.library.filter((image) => image.active);
  state.session = seededShuffle(active, hashString(state.dailyKey)).slice(0, Math.min(ROUND_COUNT, active.length));
  state.roundIndex = 0;
  state.guess = null;
  state.scores = [];
  state.phase = state.session.length > 0 ? "playing" : "empty";
  if (state.phase === "playing") startRoundTimer();
  render();
}

function startRoundTimer() {
  stopTimer();
  state.remaining = ROUND_SECONDS;
  state.deadline = Date.now() + ROUND_SECONDS * 1000;
  state.timerId = window.setInterval(() => {
    state.remaining = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    if (state.remaining <= 0) {
      submitGuess(true);
    } else {
      updateTimerText();
    }
  }, 250);
}

function stopTimer() {
  if (state.timerId) window.clearInterval(state.timerId);
  state.timerId = null;
}

function submitGuess(timedOut = false) {
  if (state.phase !== "playing") return;
  if (!state.guess && !timedOut) return;

  stopTimer();
  const round = currentRound();
  const score = scoreGuess(round.coord, state.guess);
  state.scores.push({ imageId: round.id, title: round.title, guess: state.guess, truth: round.coord, ...score });
  if (state.roundIndex + 1 >= state.session.length) {
    saveDailyResult();
  }
  state.phase = "result";
  render();
}

function nextRound() {
  if (state.phase !== "result") return;
  state.roundIndex += 1;
  state.guess = null;
  if (state.roundIndex >= state.session.length) {
    saveDailyResult();
    state.phase = "final";
    render();
    return;
  }
  state.phase = "playing";
  startRoundTimer();
  render();
}

function scoreGuess(truth, guess) {
  if (!guess) return { distanceKm: null, points: 0 };
  const distanceKm = Math.hypot(
    (truth.x - guess.x) * ATLAS_WIDTH_KM,
    (truth.y - guess.y) * ATLAS_HEIGHT_KM,
  );
  const ratio = Math.exp(-distanceKm / SCORE_DECAY_KM);
  return {
    distanceKm,
    points: Math.round(MAX_POINTS_PER_ROUND * ratio),
  };
}

function currentRound() {
  return state.session[state.roundIndex];
}

function render() {
  if (state.route === "admin") {
    renderAdmin();
    return;
  }
  renderPlayer();
}

function renderPlayer() {
  const round = currentRound();
  app.className = "app-shell";

  if ((state.phase === "idle" || state.phase === "dailyComplete") && state.dailyResult) {
    const result = state.dailyResult;
    app.innerHTML = `
      <main class="start-screen">
        <div class="brand-row">
          <a class="home-link" href="https://corinwagen.github.io/">corinwagen.github.io</a>
        </div>
        <section class="daily-complete-panel">
          <p class="eyebrow">NMPZ daily complete</p>
          <div class="daily-total">
            <strong>${result.total.toLocaleString()}</strong>
            <span>/ ${result.maxTotal.toLocaleString()}</span>
          </div>
          <p>Today's challenge has already been played. The next challenge unlocks in ${timeUntilNextUtcDay()}.</p>
          <div class="score-list start-score-list">
            ${result.scores.map((score, index) => `
              <div class="score-row">
                <span>Round ${index + 1}</span>
                <strong>${score.points.toLocaleString()}</strong>
              </div>
            `).join("")}
          </div>
        </section>
      </main>
    `;
    bindSharedActions();
    return;
  }

  if (state.phase === "idle") {
    app.innerHTML = `
      <main class="start-screen">
        <div class="brand-row">
          <a class="home-link" href="https://corinwagen.github.io/">corinwagen.github.io</a>
        </div>
        <section class="start-copy">
          <h1>TlonGuessr</h1>
          <p>locations from a world that never existed</p>
          <button class="primary-button" data-start>Start Game</button>
        </section>
      </main>
    `;
    bindSharedActions();
    return;
  }

  if (state.phase === "empty") {
    app.innerHTML = `
      <main class="start-screen">
        <div class="brand-row">
          <a class="home-link" href="https://corinwagen.github.io/">corinwagen.github.io</a>
        </div>
        <section class="start-copy">
          <p class="eyebrow">No active images</p>
          <h1>Register at least one image before playing.</h1>
          <p>Open admin directly with <code>?admin</code> to enable images.</p>
        </section>
      </main>
    `;
    bindSharedActions();
    return;
  }

  if (state.phase === "final") {
    const result = state.dailyResult || {
      scores: state.scores,
      total: state.scores.reduce((sum, score) => sum + score.points, 0),
      maxTotal: state.scores.length * MAX_POINTS_PER_ROUND,
    };
    app.innerHTML = `
      <main class="final-screen">
        <div class="brand-row final-brand">
          <span class="brand">TlonGuessr</span>
        </div>
        <section class="final-panel">
          <p class="eyebrow">NMPZ daily complete</p>
          <h1>${result.total.toLocaleString()} <span>/ ${result.maxTotal.toLocaleString()}</span></h1>
          <div class="score-list">
            ${result.scores.map((score, index) => `
              <div class="score-row">
                <span>Round ${index + 1}</span>
                <strong>${score.points.toLocaleString()}</strong>
              </div>
            `).join("")}
          </div>
          <p class="final-note">Result saved for ${state.dailyKey} UTC.</p>
        </section>
      </main>
    `;
    bindSharedActions();
    return;
  }

  const isResult = state.phase === "result";
  const lastScore = isResult ? state.scores[state.scores.length - 1] : null;
  const truthCoord = isResult ? round.coord : null;
  const guessCoord = isResult ? lastScore.guess : state.guess;

  app.innerHTML = `
    <main class="game-screen ${isResult ? "round-result-screen" : ""}">
      <img class="scene-image" src="${escapeAttr(round.src)}" alt="" draggable="false" />
      <div class="top-hud">
        <div class="hud-block">
          <span>Round</span>
          <strong>${state.roundIndex + 1}/${state.session.length}</strong>
        </div>
        <div class="hud-block mode">
          <span>Mode</span>
          <strong>NMPZ</strong>
        </div>
        <div class="hud-block timer">
          <span>Time</span>
          <strong data-timer>${formatTime(state.remaining)}</strong>
        </div>
      </div>

      ${isResult ? `
        <section class="result-card">
          <div>
            <span>Result</span>
            <strong>${lastScore.points.toLocaleString()} pts</strong>
          </div>
          <p>${lastScore.guess ? `${formatDistanceKm(lastScore.distanceKm)} away` : "No guess placed"}</p>
          <button class="primary-button" data-next>${state.roundIndex + 1 >= state.session.length ? "See final score" : "Next round"}</button>
        </section>
      ` : ""}

      <section class="corner-map ${isResult ? "result-map" : ""}">
        <div class="map-heading">
          <span>${isResult ? "Location" : "Place guess"}</span>
          <strong>${state.guess ? coordLabel(state.guess) : "No pin"}</strong>
        </div>
        <div class="map-frame" data-map></div>
        ${isResult ? "" : `
          <button class="primary-button submit-button" data-submit ${state.guess ? "" : "disabled"}>Submit</button>
        `}
      </section>
    </main>
  `;

  mountMap(app.querySelector("[data-map]"), {
    viewKey: "player",
    interactive: !isResult,
    guessCoord,
    truthCoord,
    onPick: (coord) => {
      state.guess = coord;
      render();
    },
  });

  bindSharedActions();
  app.querySelector("[data-submit]")?.addEventListener("click", () => submitGuess(false));
  app.querySelector("[data-next]")?.addEventListener("click", nextRound);
  updateTimerText();
}

function renderAdmin() {
  app.className = "app-shell admin-shell";
  if (!state.selectedId || !state.library.some((image) => image.id === state.selectedId)) {
    state.selectedId = state.library[0]?.id || null;
  }
  const selected = state.library.find((image) => image.id === state.selectedId) || null;
  const activeCount = state.library.filter((image) => image.active).length;

  app.innerHTML = `
    <main class="admin-screen">
      <header class="admin-header">
        <div>
          <span class="brand">TlonGuessr</span>
          <p>${state.library.length} images registered, ${activeCount} active</p>
        </div>
        <div class="admin-actions">
          <button class="ghost-button" data-route-play>Player</button>
          <button class="primary-button" data-export>Export JSON</button>
        </div>
      </header>

      <aside class="image-list">
        <div class="list-title">Images</div>
        ${state.library.map((image) => `
          <button class="image-list-item ${image.id === state.selectedId ? "selected" : ""}" data-select="${escapeAttr(image.id)}">
            <img src="${escapeAttr(image.src)}" alt="" />
            <span>
              <strong>${escapeHtml(image.id)}</strong>
              <em>${escapeHtml(image.title)}</em>
            </span>
            <b>${image.active ? "ON" : "OFF"}</b>
          </button>
        `).join("")}
      </aside>

      <section class="admin-workspace">
        ${selected ? renderSelectedEditor(selected) : renderEmptyEditor()}
      </section>
    </main>
  `;

  bindSharedActions();
  bindAdminActions(selected);
}

function renderSelectedEditor(selected) {
  return `
    <div class="editor-preview">
      <img src="${escapeAttr(selected.src)}" alt="" />
    </div>
    <div class="editor-panel">
      <div class="field-grid">
        <label>
          <span>ID</span>
          <input data-field="id" value="${escapeAttr(selected.id)}" />
        </label>
        <label>
          <span>Title</span>
          <input data-field="title" value="${escapeAttr(selected.title)}" />
        </label>
        <label class="wide">
          <span>Image path</span>
          <input data-field="src" value="${escapeAttr(selected.src)}" />
        </label>
        <label>
          <span>X</span>
          <input data-field="x" type="number" min="0" max="1" step="0.001" value="${selected.coord.x.toFixed(3)}" />
        </label>
        <label>
          <span>Y</span>
          <input data-field="y" type="number" min="0" max="1" step="0.001" value="${selected.coord.y.toFixed(3)}" />
        </label>
        <label class="wide">
          <span>Notes</span>
          <textarea data-field="notes">${escapeHtml(selected.notes)}</textarea>
        </label>
      </div>
      <label class="toggle-row">
        <input data-field="active" type="checkbox" ${selected.active ? "checked" : ""} />
        <span>Use in player rotation</span>
      </label>
      <div class="admin-map-wrap">
        <div>
          <span class="panel-label">Map placement</span>
          <strong>${coordLabel(selected.coord)}</strong>
        </div>
        <div class="admin-map" data-map></div>
      </div>
      <div class="register-row">
        <input data-new-src placeholder="assets/new-image.png" />
        <button class="ghost-button" data-add>Add image</button>
      </div>
      <div class="admin-footer-actions">
        <button class="ghost-button danger" data-delete>Remove selected</button>
        <button class="ghost-button" data-reset-defaults>Reset defaults</button>
      </div>
      <textarea class="export-box" data-export-box placeholder="Exported or pasted image library JSON">${escapeHtml(state.exportText)}</textarea>
      <div class="admin-footer-actions">
        <button class="ghost-button" data-import>Import pasted JSON</button>
        <button class="primary-button" data-save>Save edits</button>
      </div>
    </div>
  `;
}

function renderEmptyEditor() {
  return `
    <div class="editor-panel empty-editor">
      <p>No images registered.</p>
      <div class="register-row">
        <input data-new-src placeholder="assets/new-image.png" />
        <button class="primary-button" data-add>Add image</button>
      </div>
    </div>
  `;
}

function bindSharedActions() {
  app.querySelector("[data-start]")?.addEventListener("click", startGame);
  app.querySelectorAll("[data-route-admin]").forEach((el) => {
    el.addEventListener("click", () => setRoute("admin"));
  });
  app.querySelectorAll("[data-route-play]").forEach((el) => {
    el.addEventListener("click", () => setRoute("play"));
  });
}

function bindAdminActions(selected) {
  app.querySelectorAll("[data-select]").forEach((el) => {
    el.addEventListener("click", () => {
      state.selectedId = el.dataset.select;
      render();
    });
  });

  if (selected) {
    mountMap(app.querySelector("[data-map]"), {
      viewKey: "admin",
      interactive: true,
      guessCoord: selected.coord,
      truthCoord: selected.coord,
      onPick: (coord) => {
        updateSelected((image) => ({ ...image, coord }));
      },
    });

    app.querySelectorAll("[data-field]").forEach((field) => {
      field.addEventListener("input", () => {
        const key = field.dataset.field;
        updateSelected((image) => fieldPatch(image, key, field));
      });
    });

    app.querySelector("[data-delete]")?.addEventListener("click", () => {
      state.library = state.library.filter((image) => image.id !== selected.id);
      state.selectedId = state.library[0]?.id || null;
      saveLibrary();
      render();
    });
  }

  app.querySelector("[data-add]")?.addEventListener("click", () => {
    const input = app.querySelector("[data-new-src]");
    const src = input?.value.trim();
    if (!src) return;
    const image = {
      id: uniqueId(filenameId(src), state.library),
      title: titleFromPath(src),
      src,
      coord: { x: 0.5, y: 0.5 },
      active: false,
      notes: "New image; place on map before enabling.",
    };
    state.library = [...state.library, image];
    state.selectedId = image.id;
    saveLibrary();
    render();
  });

  app.querySelector("[data-save]")?.addEventListener("click", () => {
    saveLibrary();
    render();
  });

  app.querySelector("[data-export]")?.addEventListener("click", async () => {
    state.exportText = JSON.stringify(state.library, null, 2);
    await navigator.clipboard?.writeText(state.exportText).catch(() => {});
    render();
  });

  app.querySelector("[data-import]")?.addEventListener("click", () => {
    const box = app.querySelector("[data-export-box]");
    try {
      const imported = normalizeLibrary(JSON.parse(box.value));
      state.library = imported;
      state.selectedId = imported[0]?.id || null;
      state.exportText = "";
      saveLibrary();
      render();
    } catch (error) {
      state.exportText = `Import failed: ${error.message}`;
      render();
    }
  });

  app.querySelector("[data-reset-defaults]")?.addEventListener("click", () => {
    state.library = clone(DEFAULT_IMAGE_LIBRARY);
    state.selectedId = state.library[0]?.id || null;
    state.exportText = "";
    saveLibrary();
    render();
  });
}

function fieldPatch(image, key, field) {
  if (key === "id") return { ...image, id: field.value.trim() || image.id };
  if (key === "title") return { ...image, title: field.value };
  if (key === "src") return { ...image, src: field.value.trim() };
  if (key === "x") return { ...image, coord: { ...image.coord, x: clamp01(Number(field.value)) } };
  if (key === "y") return { ...image, coord: { ...image.coord, y: clamp01(Number(field.value)) } };
  if (key === "notes") return { ...image, notes: field.value };
  if (key === "active") return { ...image, active: field.checked };
  return image;
}

function updateSelected(updater) {
  state.library = state.library.map((image) => {
    if (image.id !== state.selectedId) return image;
    const updated = updater(image);
    state.selectedId = updated.id;
    return updated;
  });
  saveLibrary();
  render();
}

function mountMap(container, options) {
  if (!container) return;
  container.innerHTML = mapMarkup(options);
  const svg = container.querySelector("svg");
  if (!svg) return;

  const viewKey = options.viewKey || "player";
  const controls = container.querySelector(".map-controls");
  const zoomText = container.querySelector("[data-zoom-level]");
  let didPan = false;
  let drag = null;

  const applyView = () => {
    const view = state.mapViews[viewKey];
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.width} ${view.height}`);
    if (zoomText) zoomText.textContent = `${Math.round((MAP_WIDTH / view.width) * 100)}%`;
  };

  const setView = (next) => {
    state.mapViews[viewKey] = clampMapView(next);
    applyView();
  };

  applyView();

  controls?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-zoom]");
    if (!button) return;
    event.stopPropagation();
    const view = state.mapViews[viewKey];
    const center = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    if (button.dataset.zoom === "in") setView(zoomMapView(view, center, 1.65));
    if (button.dataset.zoom === "out") setView(zoomMapView(view, center, 1 / 1.65));
    if (button.dataset.zoom === "reset") setView(fullMapView());
  });

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const point = svgPointFromEvent(svg, event);
    const factor = event.deltaY < 0 ? 1.25 : 1 / 1.25;
    setView(zoomMapView(state.mapViews[viewKey], point, factor));
  }, { passive: false });

  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = {
      x: event.clientX,
      y: event.clientY,
      view: { ...state.mapViews[viewKey] },
    };
    didPan = false;
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) didPan = true;
    setView({
      ...drag.view,
      x: drag.view.x - (dx / rect.width) * drag.view.width,
      y: drag.view.y - (dy / rect.height) * drag.view.height,
    });
  });

  svg.addEventListener("pointerup", (event) => {
    svg.releasePointerCapture(event.pointerId);
    drag = null;
  });

  svg.addEventListener("click", (event) => {
    if (!options.interactive || didPan) return;
    const point = svgPointFromEvent(svg, event);
    options.onPick({
      x: clamp01(point.x / MAP_WIDTH),
      y: clamp01(point.y / MAP_HEIGHT),
    });
  });
}

function mapMarkup({ guessCoord, truthCoord }) {
  const guess = guessCoord ? markerMarkup(guessCoord, "#f0d95f", "guess") : "";
  const truth = truthCoord ? markerMarkup(truthCoord, "#57d37a", "truth") : "";
  const line = guessCoord && truthCoord
    ? `<line x1="${guessCoord.x * MAP_WIDTH}" y1="${guessCoord.y * MAP_HEIGHT}" x2="${truthCoord.x * MAP_WIDTH}" y2="${truthCoord.y * MAP_HEIGHT}" stroke="#f6f1df" stroke-width="4" stroke-dasharray="18 14" opacity="0.78" />`
    : "";
  const asset = MAP_ASSET_URL
    ? `<image href="${escapeAttr(MAP_ASSET_URL)}" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" preserveAspectRatio="xMidYMid meet" />`
    : fallbackMapMarkup();

  return `
    <div class="map-controls" aria-label="Map zoom controls">
      <button type="button" data-zoom="out" title="Zoom out">-</button>
      <span data-zoom-level>100%</span>
      <button type="button" data-zoom="in" title="Zoom in">+</button>
      <button type="button" data-zoom="reset" title="Reset map view">Reset</button>
    </div>
    <svg viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-label="TlonGuessr map">
      ${asset}
      ${line}
      ${guess}
      ${truth}
    </svg>
  `;
}

function svgPointFromEvent(svg, event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function zoomMapView(view, point, factor) {
  const nextWidth = clampNumber(view.width / factor, MAP_WIDTH / 4, MAP_WIDTH);
  const nextHeight = clampNumber(view.height / factor, MAP_HEIGHT / 4, MAP_HEIGHT);
  const rx = (point.x - view.x) / view.width;
  const ry = (point.y - view.y) / view.height;

  return {
    x: point.x - rx * nextWidth,
    y: point.y - ry * nextHeight,
    width: nextWidth,
    height: nextHeight,
  };
}

function clampMapView(view) {
  const width = clampNumber(view.width, MAP_WIDTH / 4, MAP_WIDTH);
  const height = clampNumber(view.height, MAP_HEIGHT / 4, MAP_HEIGHT);
  return {
    x: clampNumber(view.x, 0, MAP_WIDTH - width),
    y: clampNumber(view.y, 0, MAP_HEIGHT - height),
    width,
    height,
  };
}

function fallbackMapMarkup() {
  return `
    <rect width="600" height="380" fill="#1a2535" />
    <path d="M228,38 L360,34.2 L360,133 L300,152 L210,133 L168,83.6 Z" fill="#c8a96e" fill-opacity="0.54" />
    <path d="M210,133 L300,152 L330,228 L240,247 L168,220.4 L168,159.6 Z" fill="#7a9e7a" fill-opacity="0.56" />
    <path d="M48,209 L108,159.6 L168,159.6 L168,220.4 L108,266 L60,239.4 Z" fill="#5d8aa8" fill-opacity="0.58" />
    <path d="M330,228 L420,209 L480,228 L456,296.4 L390,315.4 L318,326.8 L240,319.2 L240,247 Z" fill="#8a7a9e" fill-opacity="0.56" />
    <path d="M360,133 L480,114 L528,152 L510,209 L420,209 L330,228 L300,152 Z" fill="#c47a5a" fill-opacity="0.56" />
    <path d="M48,209 L72,121.6 L108,83.6 L168,53.2 L228,38 L300,30.4 L360,34.2 L420,45.6 L480,68.4 L528,98.8 L558,136.8 L564,182.4 L546,228 L510,266 L456,296.4 L390,315.4 L318,326.8 L240,319.2 L168,296.4 L108,266 L60,239.4 Z" fill="none" stroke="#b2a179" stroke-width="2.2" />
    <path d="M120,108 C180,130 225,120 276,91" fill="none" stroke="#263a4b" stroke-width="5" opacity="0.45" />
    <path d="M275,252 C345,228 418,240 493,200" fill="none" stroke="#263a4b" stroke-width="5" opacity="0.45" />
    <path d="M80,300 C145,272 180,286 232,258" fill="none" stroke="#d7c28c" stroke-width="1" opacity="0.35" />
    <text x="300" y="362" text-anchor="middle" fill="#d6c17e" opacity="0.55" font-size="12" font-family="Georgia, serif">temporary atlas sketch</text>
  `;
}

function markerMarkup(coord, color, label) {
  const x = coord.x * MAP_WIDTH;
  const y = coord.y * MAP_HEIGHT;
  return `
    <g>
      <circle cx="${x}" cy="${y}" r="18" fill="${color}" stroke="#11131a" stroke-width="5" />
      <circle cx="${x}" cy="${y}" r="38" fill="none" stroke="${color}" stroke-width="4" opacity="0.58" />
      <text x="${x}" y="${Math.max(34, y - 48)}" text-anchor="middle" fill="${color}" font-size="30" font-family="Georgia, serif">${label}</text>
    </g>
  `;
}

function updateTimerText() {
  const timer = app.querySelector("[data-timer]");
  if (timer) timer.textContent = formatTime(state.remaining);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function seededShuffle(items, seed) {
  const rng = mulberry32(seed);
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function filenameId(src) {
  return src.split("/").pop()?.replace(/\.[^.]+$/, "") || "";
}

function titleFromPath(src) {
  return filenameId(src)
    .replace(/^[A-Z]\d+-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function uniqueId(base, library) {
  const clean = base || "image";
  const ids = new Set(library.map((image) => image.id));
  if (!ids.has(clean)) return clean;
  let suffix = 2;
  while (ids.has(`${clean}-${suffix}`)) suffix += 1;
  return `${clean}-${suffix}`;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function timeUntilNextUtcDay(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  const totalMinutes = Math.max(1, Math.ceil((next - now.getTime()) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function formatDistanceKm(distanceKm) {
  if (!Number.isFinite(distanceKm)) return "unknown distance";
  if (distanceKm < 10) return `${distanceKm.toFixed(1)} km`;
  return `${Math.round(distanceKm).toLocaleString()} km`;
}

function coordLabel(coord) {
  return `${coord.x.toFixed(3)}, ${coord.y.toFixed(3)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

window.addEventListener("popstate", () => {
  state.route = new URLSearchParams(window.location.search).has("admin") ? "admin" : "play";
  render();
});

render();

import { DEFAULT_TRACK, PIECES, addPiece, lapLengthMeters, moveInCourse, removePiece, snap, updatePiece } from "./track.js";
import { drawTrack, rotateHandle } from "./track-view.js";

const canvas = document.querySelector("#field");
const message = document.querySelector("#message");
const saveState = document.querySelector("#save-state");
const lapLength = document.querySelector("#lap-length");
const fields = {
  x: document.querySelector("#piece-x"),
  y: document.querySelector("#piece-y"),
  rotation: document.querySelector("#piece-rotation"),
  width: document.querySelector("#field-width"),
  depth: document.querySelector("#field-depth"),
  grid: document.querySelector("#field-grid"),
};

let track = structuredClone(DEFAULT_TRACK);
let selectedId = null;
let placing = null;
let drag = null;
let scale = 1;
let saveTimer = null;
const history = [];

const say = (text, isError = false) => {
  message.textContent = text;
  message.classList.toggle("error", isError);
};

const selected = () => track.pieces.find((piece) => piece.id === selectedId) ?? null;

const commit = (next, { remember = true } = {}) => {
  if (remember) history.push(structuredClone(track));
  if (history.length > 100) history.shift();
  track = next;
  draw();
  saveState.textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
};

const save = async () => {
  try {
    const response = await fetch("/api/track", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ track }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Save failed.");
    saveState.textContent = "Saved";
  } catch (error) {
    saveState.textContent = "Not saved";
    say(error.message, true);
  }
};

const draw = () => {
  canvas.height = Math.round((canvas.width * track.depthMeters) / track.widthMeters);
  scale = drawTrack(canvas, track, { selectedId });
  const meters = lapLengthMeters(track);
  const course = track.pieces.filter((piece) => PIECES[piece.type].course).length;
  lapLength.textContent = meters > 0 ? `One lap is about ${meters} m through ${course} course pieces` : "Place at least two course pieces to measure a lap";
  const piece = selected();
  document.querySelector("#selected-fields").hidden = piece == null;
  document.querySelector("#selected-help").textContent = piece == null
    ? "Click a piece to select it. Drag to move it, or drag its round handle to turn it."
    : `${PIECES[piece.type].title}${piece.order != null ? `, number ${piece.order} in the lap` : ", marks the line only"}.`;
  document.querySelector("#order-buttons").hidden = piece?.order == null;
  if (piece != null && document.activeElement?.closest?.("#selected-fields") == null) {
    fields.x.value = String(piece.x);
    fields.y.value = String(piece.y);
    fields.rotation.value = String(piece.rotation);
  }
  if (!["width", "depth", "grid"].some((key) => document.activeElement === fields[key])) {
    fields.width.value = String(track.widthMeters);
    fields.depth.value = String(track.depthMeters);
    fields.grid.value = String(track.gridMeters);
  }
};

const toMeters = (event) => {
  const rect = canvas.getBoundingClientRect();
  const ratio = canvas.width / rect.width;
  return { x: ((event.clientX - rect.left) * ratio) / scale, y: ((event.clientY - rect.top) * ratio) / scale };
};

const pieceAt = (point) => {
  for (const piece of [...track.pieces].reverse()) {
    const spec = PIECES[piece.type];
    const angle = (-piece.rotation * Math.PI) / 180;
    const dx = point.x - piece.x;
    const dy = point.y - piece.y;
    const localX = dx * Math.cos(angle) - dy * Math.sin(angle);
    const localY = dx * Math.sin(angle) + dy * Math.cos(angle);
    if (Math.abs(localX) <= spec.width / 2 + 0.4 && Math.abs(localY) <= spec.depth / 2 + 0.4) return piece;
  }
  return null;
};

const palette = document.querySelector("#palette");
for (const [type, spec] of Object.entries(PIECES)) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.type = type;
  button.innerHTML = `<i class="swatch" style="background:${spec.color}"></i> ${spec.title}`;
  button.addEventListener("click", () => {
    placing = placing === type ? null : type;
    for (const other of palette.querySelectorAll("button")) other.setAttribute("aria-pressed", String(other.dataset.type === placing));
    say(placing == null ? "" : `Click the field to place a ${spec.title.toLowerCase()}.`);
  });
  palette.append(button);
}

canvas.addEventListener("pointerdown", (event) => {
  const point = toMeters(event);
  canvas.focus();
  if (placing != null) {
    const id = crypto.randomUUID();
    const x = Math.min(track.widthMeters, Math.max(0, snap(point.x, track.gridMeters)));
    const y = Math.min(track.depthMeters, Math.max(0, snap(point.y, track.gridMeters)));
    commit(addPiece(track, placing, x, y, id));
    selectedId = id;
    draw();
    return;
  }
  const current = selected();
  if (current != null) {
    const handle = rotateHandle(current);
    if (Math.hypot(point.x - handle.x, point.y - handle.y) < 0.8) {
      drag = { kind: "rotate", id: current.id, before: structuredClone(track) };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
  }
  const hit = pieceAt(point);
  selectedId = hit?.id ?? null;
  if (hit != null) {
    drag = { kind: "move", id: hit.id, offsetX: point.x - hit.x, offsetY: point.y - hit.y, before: structuredClone(track) };
    canvas.setPointerCapture(event.pointerId);
  }
  draw();
});

canvas.addEventListener("pointermove", (event) => {
  if (drag == null) return;
  const point = toMeters(event);
  const piece = track.pieces.find((item) => item.id === drag.id);
  if (piece == null) return;
  if (drag.kind === "move") {
    const x = Math.min(track.widthMeters, Math.max(0, snap(point.x - drag.offsetX, track.gridMeters)));
    const y = Math.min(track.depthMeters, Math.max(0, snap(point.y - drag.offsetY, track.gridMeters)));
    track = updatePiece(track, piece.id, { x, y });
  } else {
    const degrees = (Math.atan2(point.x - piece.x, -(point.y - piece.y)) * 180) / Math.PI;
    const rotation = ((Math.round(degrees / 15) * 15) % 360 + 360) % 360;
    track = updatePiece(track, piece.id, { rotation });
  }
  draw();
});

canvas.addEventListener("pointerup", () => {
  if (drag == null) return;
  const before = drag.before;
  drag = null;
  if (JSON.stringify(before) !== JSON.stringify(track)) {
    const after = track;
    track = before;
    commit(after);
  }
});

canvas.addEventListener("keydown", (event) => {
  const piece = selected();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    const previous = history.pop();
    if (previous != null) commit(previous, { remember: false });
    return;
  }
  if (piece == null) return;
  const step = event.shiftKey ? 5 : Math.max(0.5, track.gridMeters || 0.5);
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[event.key]) {
    event.preventDefault();
    const [dx, dy] = moves[event.key];
    commit(updatePiece(track, piece.id, {
      x: Math.min(track.widthMeters, Math.max(0, piece.x + dx)),
      y: Math.min(track.depthMeters, Math.max(0, piece.y + dy)),
    }));
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    commit(removePiece(track, piece.id));
    selectedId = null;
    draw();
  }
});

for (const key of ["x", "y", "rotation"]) {
  fields[key].addEventListener("change", () => {
    const piece = selected();
    if (piece == null) return;
    const value = Number(fields[key].value);
    if (!Number.isFinite(value)) return;
    const limit = key === "x" ? track.widthMeters : key === "y" ? track.depthMeters : 359;
    commit(updatePiece(track, piece.id, { [key]: key === "rotation" ? ((value % 360) + 360) % 360 : Math.min(limit, Math.max(0, value)) }));
  });
}

document.querySelector("#order-earlier").addEventListener("click", () => selectedId && commit(moveInCourse(track, selectedId, -1)));
document.querySelector("#order-later").addEventListener("click", () => selectedId && commit(moveInCourse(track, selectedId, 1)));
document.querySelector("#remove-piece").addEventListener("click", () => {
  if (selectedId == null) return;
  commit(removePiece(track, selectedId));
  selectedId = null;
  draw();
});
document.querySelector("#clear-track").addEventListener("click", () => {
  if (track.pieces.length === 0 || !confirm("Remove every piece from the track?")) return;
  commit({ ...track, pieces: [] });
  selectedId = null;
  draw();
});

for (const [key, prop, min, max] of [["width", "widthMeters", 10, 500], ["depth", "depthMeters", 10, 500], ["grid", "gridMeters", 0, 10]]) {
  fields[key].addEventListener("change", () => {
    const value = Number(fields[key].value);
    if (!Number.isFinite(value)) return;
    commit({ ...track, [prop]: Math.min(max, Math.max(min, value)) });
  });
}

const load = async () => {
  const state = await (await fetch("/api/state")).json();
  document.querySelector("#event-title").textContent = state.event.name;
  document.body.dataset.theme = state.event.theme ?? "night";
  track = state.event.track ?? structuredClone(DEFAULT_TRACK);
  saveState.textContent = state.event.track ? "Saved" : "";
  draw();
};

load();

import { DETECT_MODES } from "/video/aruco-detector.js";
import {
  ARUCO_DEFAULTS,
  ArucoTimingSystem,
  DETECTION_FRAME,
  FpsCounter,
  effectiveMarkerIds,
  reportChannelDetections,
} from "/video/aruco-timing.js";
import { parseCalibration } from "/video/calibration.js";
import { markerGrid, markerSvg } from "/video/marker-sheet.js";
import { AutoCrashOut, MOTION_STATES } from "/video/motion-detector.js";
import { HeldDetections, drawOverlay } from "/video/overlay.js";

const { width: FRAME_W, height: FRAME_H } = DETECTION_FRAME;
const MOTION_W = 160;
const MOTION_H = 120;
/** Longer than the desk's 5 s minimum lap, so every simulated pass counts. */
const TEST_CYCLE_MS = 6500;
const SETTINGS_KEY = "webfpv.camera.settings";
const CALIBRATION_KEY = "webfpv.camera.calibration";
const SOURCES_KEY = "webfpv.camera.sources";
const PAGE_DEFAULTS = Object.freeze({ detectionFps: 30, crashOut: false, crashDelaySeconds: 5 });

const FIELD_GROUPS = [
  {
    legend: "Gate",
    fields: [
      { key: "markerIds", label: "Gate marker IDs", type: "text", help: "Comma-separated, 0 to 49. Print the same IDs below." },
      { key: "markerThreshold", label: "Markers needed in view", type: "number", min: 1, max: 8, step: 1, help: "How many gate markers must be seen at once before the gate counts as entered." },
      { key: "flickerLengthMs", label: "Flicker window, ms", type: "number", min: 0, max: 2000, step: 10, help: "Markers may drop out this long without ending the pass. The lap is timed when they vanished." },
      { key: "minMarkerPercent", label: "Smallest marker, % of the picture", type: "number", min: 0, max: 50, step: 0.01, help: "Smaller markers are ignored, so a far-off gate does not count." },
    ],
  },
  {
    legend: "Detection",
    fields: [
      { key: "detectMode", label: "Mode", type: "select", options: DETECT_MODES, help: "Original reads the picture as it arrives. Corrected straightens the lens first and needs a calibration file. Hybrid does both." },
      { key: "errorCorrectionRate", label: "Error correction, 0 to 1", type: "number", min: 0, max: 1, step: 0.05, help: "Higher accepts worn or blurry markers but can misread." },
      { key: "hybridDistanceThreshold", label: "Hybrid match distance, px", type: "number", min: 1, max: 200, step: 1, help: "How close the two passes must agree to count as one marker." },
      { key: "detectionFps", label: "Checks per second", type: "number", min: 1, max: 60, step: 1, help: "How often each channel's picture is read. Lower it if the computer struggles." },
      { key: "useMultiThreadDetection", label: "One detector thread per channel", type: "check" },
    ],
  },
  {
    legend: "Static",
    fields: [
      { key: "ignoreLostSignal", label: "Skip frames that turn to static", type: "check" },
      { key: "lostSignalThreshold", label: "Static below, 0 to 1", type: "number", min: 0, max: 1, step: 0.05, help: "Analogue snow has little large-scale detail. Turn on the signal readout to see live values." },
    ],
  },
  {
    legend: "On the picture",
    fields: [
      { key: "showMarkerBox", label: "Outline markers: blue raw, yellow corrected, green both", type: "check" },
      { key: "showMarkerId", label: "Marker ID", type: "check" },
      { key: "showMarkerSizePercent", label: "Marker size", type: "check" },
      { key: "showFps", label: "Checks per second", type: "check" },
      { key: "showSignalRatio", label: "Signal readout", type: "check" },
    ],
  },
];

const MOTION_TEXT = {
  [MOTION_STATES.Unknown]: "motion: learning",
  [MOTION_STATES.ActiveMotion]: "moving",
  [MOTION_STATES.ActiveNoMotion]: "still picture",
  [MOTION_STATES.InactiveMotion]: "dim, moving",
  [MOTION_STATES.InactiveNoMotion]: "no picture",
};

const $ = (selector) => document.querySelector(selector);
const title = $("#event-title");
const heatLine = $("#heat-line");
const fieldsBox = $("#fields");
const tilesBox = $("#tiles");
const logList = $("#log");
const message = $("#message");
const calibrationStatus = $("#calibration-status");
const crashOn = $("#crash-on");
const crashDelay = $("#crash-delay");
const sheetIdsInput = $("#sheet-ids");
const sheetCopies = $("#sheet-copies");
const sheetSize = $("#sheet-size");
const sheetPreview = $("#sheet-preview");
const printSheet = $("#print-sheet");

const loadJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const saveJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const system = new ArucoTimingSystem({ ...PAGE_DEFAULTS, ...loadJson(SETTINGS_KEY, {}), role: "Primary" });
const settings = system.settings;
const crash = new AutoCrashOut({ startDelayMs: settings.crashDelaySeconds * 1000 });
let calibration = parseCalibration(loadJson(CALIBRATION_KEY, null)).calibration ?? null;

let state = null;
let devices = [];
let sharedWorker = null;
let audio = null;
const tiles = new Map();
const crashInFlight = new Set();
const heat = { key: null, race: null, round: null, running: false, slots: new Map() };

const saveSettings = () => {
  const { role, ...kept } = settings;
  saveJson(SETTINGS_KEY, kept);
};

const setMessage = (text, isError = false) => {
  message.textContent = text ?? "";
  message.classList.toggle("error", isError);
};

const log = (text, kind = "info") => {
  const item = document.createElement("li");
  item.dataset.kind = kind;
  item.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  logList.prepend(item);
  while (logList.children.length > 80) logList.lastElementChild.remove();
};

const request = async (url, options) => {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed.");
  return body;
};

const blip = () => {
  if (state?.event.sound === false) return;
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") audio.resume();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.frequency.value = 1320;
    gain.gain.value = 0.05;
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.06);
  } catch {
    // The page still times laps without sound.
  }
};

const pilotName = (pilotId) => state?.event.pilots.find((pilot) => pilot.id === pilotId)?.name ?? "Pilot";
const channelById = (channelId) => state?.event.channels.find((channel) => channel.id === channelId) ?? null;

const findRace = (event, raceId) => {
  for (const round of event.rounds) {
    const race = round.races.find((candidate) => candidate.id === raceId);
    if (race != null) return { round, race };
  }
  return null;
};

const heatName = (round, race) => `Round ${round.number}, heat ${race.number}`;

// ---- Detector threads -------------------------------------------------------------

const makeWorker = () => {
  const worker = new Worker("/video/detector-worker.js", { type: "module" });
  worker.onmessage = ({ data }) => onDetections(data);
  worker.onerror = (event) => {
    log(`A detector thread stopped: ${event.message || "unknown error"}`, "error");
    for (const entry of tiles.values()) entry.busy = false;
  };
  worker.postMessage({ type: "calibration", calibration });
  return worker;
};

const workerFor = (entry) => {
  if (settings.useMultiThreadDetection) return (entry.worker ??= makeWorker());
  return (sharedWorker ??= makeWorker());
};

const resetWorkers = () => {
  sharedWorker?.terminate();
  sharedWorker = null;
  for (const entry of tiles.values()) {
    entry.worker?.terminate();
    entry.worker = null;
    entry.busy = false;
  }
};

const broadcastCalibration = () => {
  sharedWorker?.postMessage({ type: "calibration", calibration });
  for (const entry of tiles.values()) entry.worker?.postMessage({ type: "calibration", calibration });
};

// ---- Tiles and video sources -------------------------------------------------------

const makeCanvas = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const fillSourceOptions = (entry) => {
  const add = (value, text) => {
    const option = element("option", null, text);
    option.value = value;
    entry.select.append(option);
  };
  entry.select.replaceChildren();
  add("none", "No video");
  add("test", "Test pattern: a simulated gate");
  add("still", "Still picture: a crashed quad");
  devices.forEach((device, index) => add(`camera:${device.deviceId}`, device.label || `Camera ${index + 1}`));
  add("file", entry.source === "file" ? `Video file: ${entry.fileName}` : "Video file…");
  const known = [...entry.select.options].some((option) => option.value === entry.source);
  entry.select.value = known ? entry.source : "none";
};

const createTile = (channel, index) => {
  const tile = element("article", "tile");
  tile.style.setProperty("--channel", channel.color ?? "var(--line)");
  const head = element("div", "tile-head");
  const swatch = element("span", "swatch");
  swatch.style.background = channel.color ?? "var(--line)";
  const pilot = element("span", "pilot");
  const gate = element("span", "badge", "Clear");
  head.append(swatch, element("strong", null, channel.name), element("span", "meta", `${channel.frequencyMhz} MHz`), pilot, gate);
  const canvas = makeCanvas(FRAME_W, FRAME_H);
  const select = element("select");
  const label = element("label");
  label.append("Video source", select);
  const file = element("input");
  file.type = "file";
  file.accept = "video/*";
  file.hidden = true;
  const status = element("p", "tile-status help");
  tile.append(head, canvas, label, file, status);
  const grab = makeCanvas(FRAME_W, FRAME_H);
  const motion = makeCanvas(MOTION_W, MOTION_H);
  const entry = {
    channel,
    tile,
    canvas,
    ctx: canvas.getContext("2d"),
    select,
    file,
    status,
    pilot,
    gate,
    grab,
    grabCtx: grab.getContext("2d", { willReadFrequently: true }),
    motion,
    motionCtx: motion.getContext("2d", { willReadFrequently: true }),
    source: "none",
    fileName: "",
    video: null,
    stream: null,
    objectUrl: null,
    held: new HeldDetections(),
    fps: new FpsCounter(),
    ratio: Number.NaN,
    blanked: false,
    busy: false,
    frameId: 0,
    pending: null,
    worker: null,
    lastLap: "",
    motionState: MOTION_STATES.Unknown,
    testOffsetMs: index * 1700,
    statusAt: 0,
  };
  select.addEventListener("change", () => setSource(entry, select.value));
  file.addEventListener("change", () => openFile(entry));
  fillSourceOptions(entry);
  return entry;
};

const rememberSources = () => {
  const kept = {};
  for (const [channelId, entry] of tiles) {
    if (entry.source === "test" || entry.source === "still" || entry.source.startsWith("camera:")) kept[channelId] = entry.source;
  }
  saveJson(SOURCES_KEY, kept);
};

const releaseSource = (entry) => {
  entry.stream?.getTracks().forEach((track) => track.stop());
  entry.video?.pause();
  if (entry.objectUrl != null) URL.revokeObjectURL(entry.objectUrl);
  entry.stream = null;
  entry.video = null;
  entry.objectUrl = null;
  entry.ratio = Number.NaN;
  entry.blanked = false;
  entry.held.set([]);
};

const playVideo = async (entry, setup) => {
  const video = element("video");
  video.muted = true;
  video.playsInline = true;
  setup(video);
  await video.play();
  entry.video = video;
};

const setSource = async (entry, value) => {
  if (value === "file") {
    entry.select.value = entry.source;
    entry.file.click();
    return;
  }
  releaseSource(entry);
  entry.source = value;
  rememberSources();
  if (!value.startsWith("camera:")) return;
  try {
    entry.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: value.slice("camera:".length) }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    await playVideo(entry, (video) => {
      video.srcObject = entry.stream;
    });
    log(`${entry.channel.name}: camera connected`);
  } catch (error) {
    releaseSource(entry);
    entry.source = "none";
    fillSourceOptions(entry);
    rememberSources();
    setMessage(`${entry.channel.name}: the camera did not start (${error.message}).`, true);
  }
};

const openFile = async (entry) => {
  const picked = entry.file.files?.[0];
  entry.file.value = "";
  if (picked == null) return;
  releaseSource(entry);
  entry.source = "file";
  entry.fileName = picked.name;
  entry.objectUrl = URL.createObjectURL(picked);
  try {
    await playVideo(entry, (video) => {
      video.loop = true;
      video.src = entry.objectUrl;
    });
    log(`${entry.channel.name}: playing ${picked.name}`);
  } catch (error) {
    releaseSource(entry);
    entry.source = "none";
    setMessage(`${picked.name} could not be played (${error.message}).`, true);
  }
  fillSourceOptions(entry);
  rememberSources();
};

const refreshDevices = async () => {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  devices = all.filter((device) => device.kind === "videoinput" && device.deviceId !== "");
  for (const entry of tiles.values()) fillSourceOptions(entry);
};

const syncTiles = () => {
  const channels = state.event.channels;
  const wanted = new Set(channels.map((channel) => channel.id));
  for (const [channelId, entry] of tiles) {
    if (wanted.has(channelId)) continue;
    releaseSource(entry);
    entry.worker?.terminate();
    entry.tile.remove();
    tiles.delete(channelId);
  }
  const saved = loadJson(SOURCES_KEY, {});
  channels.forEach((channel, index) => {
    let entry = tiles.get(channel.id);
    if (entry == null) {
      entry = createTile(channel, index);
      tiles.set(channel.id, entry);
      tilesBox.append(entry.tile);
      if (saved[channel.id] != null) setSource(entry, saved[channel.id]).then(() => fillSourceOptions(entry));
    }
    entry.channel = channel;
    const slot = heat.slots.get(channel.id);
    entry.tile.dataset.heat = String(slot != null || heat.race == null);
    entry.pilot.textContent =
      slot != null ? `${pilotName(slot.pilotId)}${slot.crashed ? " · crashed" : ""}` : heat.race != null ? "Not in this heat" : "";
  });
};

// ---- The desk's current heat --------------------------------------------------------

const renderHeader = () => {
  const { event } = state;
  document.body.dataset.theme = event.theme ?? "night";
  title.textContent = event.name;
  if (heat.race == null) {
    heatLine.textContent =
      event.rounds.length === 0
        ? "No heat drawn yet. Set up the video now, then draw a round on the race desk."
        : "Every heat has a result. Draw the next round on the race desk.";
    return;
  }
  const who = [...heat.slots.values()]
    .map((slot) => `${channelById(slot.channelId)?.name ?? "?"} ${pilotName(slot.pilotId)}`)
    .join(", ");
  const name = heatName(heat.round, heat.race);
  if (heat.running) heatLine.textContent = `${name} is running. Watching ${who}.`;
  else if (heat.race.endedAt != null) heatLine.textContent = `${name} has finished. Draw the next round on the race desk.`;
  else if (heat.race.pausedAt != null) heatLine.textContent = `${name} is paused.`;
  else if (heat.race.startedAt != null) heatLine.textContent = `${name}: waiting for the start horn.`;
  else heatLine.textContent = `${name} is next: ${who}. Start it on the race desk; laps are timed here.`;
};

let hornTimer = null;

const applyState = (next) => {
  state = next;
  const raceId = next.cursor?.current?.raceId;
  const located = raceId != null ? findRace(next.event, raceId) : null;
  const race = located?.race ?? null;
  const live = race != null && race.startedAt != null && race.endedAt == null && race.pausedAt == null;
  // The desk holds the start for a random moment; FPVTrackside starts detection at the horn.
  const untilHorn = live ? Date.parse(race.startedAt) - Date.now() : 0;
  const running = live && untilHorn <= 0;
  clearTimeout(hornTimer);
  if (live && untilHorn > 0) hornTimer = setTimeout(() => applyState(state), untilHorn + 5);
  const key = race != null ? `${race.id}@${race.startedAt}` : null;
  if (heat.running && (!running || key !== heat.key)) {
    system.endDetection();
    const ended = key !== heat.key || race?.endedAt != null;
    if (ended) crash.raceEnded();
    log(`${heatName(heat.round, heat.race)} ${ended ? "finished" : "paused"}`);
  }
  const startedNow = running && (!heat.running || key !== heat.key);
  Object.assign(heat, {
    key,
    race,
    round: located?.round ?? null,
    running,
    slots: new Map((race?.slots ?? []).map((slot) => [slot.channelId, slot])),
  });
  if (startedNow) {
    const watched = race.slots.map((slot) => channelById(slot.channelId)).filter((channel) => channel != null);
    system.setListeningFrequencies(watched.map((channel) => channel.frequencyMhz));
    system.startDetection();
    crash.raceStarted(Date.parse(race.startedAt));
    log(`${heatName(heat.round, race)} started: watching ${watched.map((channel) => channel.name).join(", ")}`);
  }
  renderHeader();
  syncTiles();
};

const lapAt = (snapshot, raceId, channelId, time) => {
  const race = findRace(snapshot.event, raceId)?.race;
  const slot = race?.slots.find((candidate) => candidate.channelId === channelId);
  const endedAt = new Date(time).toISOString();
  return slot?.laps.find((lap) => lap.endedAt === endedAt) ?? null;
};

const sendPass = async (entry, pass, raceId) => {
  const name = pilotName(heat.slots.get(entry.channel.id)?.pilotId);
  try {
    const result = await request(`/api/races/${encodeURIComponent(raceId)}/detect`, {
      method: "POST",
      body: JSON.stringify({ channelId: entry.channel.id, at: pass.time, peak: pass.peak }),
    });
    const lap = lapAt(result, raceId, entry.channel.id, pass.time);
    const what = lap == null ? "point" : lap.number === 0 ? "holeshot" : `lap ${lap.number}`;
    entry.lastLap = lap == null ? "" : `${what} ${lap.lengthSeconds.toFixed(3)} s`;
    const size = ((pass.peak / (FRAME_W * FRAME_H)) * 100).toFixed(1);
    log(`${entry.channel.name} ${name}: ${entry.lastLap || what} (marker ${size}% of the picture)`, "pass");
    blip();
    applyState(result);
  } catch (error) {
    log(`${entry.channel.name} ${name}: ${error.message}`, error.message.startsWith("Ignored") ? "muted" : "error");
  }
};

// ---- Frame loop ------------------------------------------------------------------------

const gridCache = new Map();
const gridFor = (id) => {
  if (!gridCache.has(id)) gridCache.set(id, markerGrid(id));
  return gridCache.get(id);
};

/** Whole-pixel cells: a soft, sub-pixel code flickers in and out of detection. */
const drawMarker = (ctx, id, x, y, cell) => {
  const { size, grid } = gridFor(id);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x - cell, y - cell, (size + 2) * cell, (size + 2) * cell);
  ctx.fillStyle = "#000";
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (grid[row * size + col] === 0) ctx.fillRect(x + col * cell, y + row * cell, cell, cell);
    }
  }
};

/** A gate with two markers seen from a quad flying at it: it grows as 1/distance, then leaves the picture. */
const drawTestPattern = (ctx, entry, now) => {
  const id = effectiveMarkerIds(settings.markerIds).find((value) => value >= 0 && value <= 49) ?? 0;
  const phase = ((now + entry.testOffsetMs) % TEST_CYCLE_MS) / TEST_CYCLE_MS;
  const horizon = Math.round(FRAME_H * 0.48);
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#6aa7d8");
  sky.addColorStop(1, "#cfe3f2");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, FRAME_W, horizon);
  // Fast, contrasty ground keeps the frame difference well above the static detector's motion
  // threshold, the way live FPV video does; the still source freezes it.
  const depth = FRAME_H - horizon;
  const offset = (now * 0.13) % 16;
  ctx.fillStyle = "#86b85a";
  ctx.fillRect(0, horizon, FRAME_W, depth);
  ctx.fillStyle = "#2f5320";
  ctx.beginPath();
  for (let x = -offset; x < FRAME_W + depth; x += 16) {
    ctx.moveTo(x, FRAME_H);
    ctx.lineTo(x + 8, FRAME_H);
    ctx.lineTo(x + 8 - depth, horizon);
    ctx.lineTo(x - depth, horizon);
    ctx.closePath();
  }
  ctx.fill();
  if (phase >= 0.8) return;
  const metres = 30 * (1 - phase / 0.8) + 1.5;
  const scale = 3 / metres;
  const cx = Math.round(FRAME_W / 2 + Math.sin(now / 900 + entry.testOffsetMs) * 14);
  const cy = Math.round(horizon + 18 * scale);
  const halfW = Math.round(130 * scale);
  const halfH = Math.round(85 * scale);
  const post = Math.max(1, Math.round(10 * scale));
  ctx.fillStyle = "#e8692d";
  ctx.fillRect(cx - halfW - (post >> 1), cy - halfH, post, halfH * 2);
  ctx.fillRect(cx + halfW - (post >> 1), cy - halfH, post, halfH * 2);
  ctx.fillRect(cx - halfW, cy - halfH - (post >> 1), halfW * 2, post);
  const cell = Math.floor((46 * scale) / 6);
  if (cell < 1) return;
  const side = cell * 6;
  drawMarker(ctx, id, cx - halfW - (side >> 1), cy - halfH + post + cell, cell);
  drawMarker(ctx, id, cx + halfW - (side >> 1), cy - halfH + post + cell, cell);
};

const drawSource = (entry, now) => {
  if (entry.source === "test") {
    drawTestPattern(entry.grabCtx, entry, now);
    return true;
  }
  if (entry.source === "still") {
    drawTestPattern(entry.grabCtx, entry, 0.9 * TEST_CYCLE_MS - entry.testOffsetMs);
    return true;
  }
  const video = entry.video;
  if (video == null || video.readyState < 2 || video.videoWidth === 0) return false;
  entry.grabCtx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
  return true;
};

const grabFrame = (entry, now) => {
  if (entry.source === "none" || entry.busy || !drawSource(entry, now)) return;
  const racing = heat.running && heat.slots.has(entry.channel.id);
  if (settings.crashOut && racing) {
    entry.motionCtx.drawImage(entry.grab, 0, 0, MOTION_W, MOTION_H);
    entry.motionState = crash.addFrame(entry.channel.id, entry.motionCtx.getImageData(0, 0, MOTION_W, MOTION_H).data, now).state;
  }
  const image = entry.grabCtx.getImageData(0, 0, FRAME_W, FRAME_H);
  entry.busy = true;
  entry.frameId += 1;
  entry.pending = { captureTime: now, racing, raceId: heat.race?.id ?? null };
  workerFor(entry).postMessage(
    {
      type: "detect",
      key: entry.channel.id,
      frameId: entry.frameId,
      width: FRAME_W,
      height: FRAME_H,
      pixels: image.data.buffer,
      mode: settings.detectMode,
      ecRate: settings.errorCorrectionRate,
      hybridDistPx: settings.hybridDistanceThreshold,
      computeRatio: settings.ignoreLostSignal || settings.showSignalRatio,
      ignoreLostSignal: settings.ignoreLostSignal,
      lostSignalThreshold: settings.lostSignalThreshold,
    },
    [image.data.buffer],
  );
};

const onDetections = (data) => {
  const entry = tiles.get(data.key);
  if (entry == null || data.frameId !== entry.frameId) return;
  entry.busy = false;
  const now = Date.now();
  entry.held.set(data.detections, now);
  entry.ratio = data.signalRatio;
  entry.blanked = data.blanked;
  entry.fps.tick(now);
  const { captureTime, racing, raceId } = entry.pending;
  // Channels outside the running heat see an empty frame, as in FPVTrackside, so they never trigger.
  const passes = reportChannelDetections([system], entry.channel.frequencyMhz, racing ? data.detections : [], captureTime, settings, FRAME_W * FRAME_H);
  for (const pass of passes) sendPass(entry, pass, raceId);
};

const finishedHeat = (slot) =>
  (heat.round?.eventType ?? "Race") === "Race" &&
  slot.laps.filter((lap) => lap.number > 0).length >= (heat.race.targetLaps ?? Infinity);

const runCrashOut = (now) => {
  crash.sample(now);
  if (!heat.running) return;
  const watched = [...heat.slots.entries()]
    .filter(([channelId, slot]) => (tiles.get(channelId)?.source ?? "none") !== "none" && slot.dnf !== true && !finishedHeat(slot))
    .map(([channelId, slot]) => ({ key: channelId, crashedOut: slot.crashed === true }));
  const raceId = heat.race.id;
  for (const change of crash.update(watched, now)) {
    if (crashInFlight.has(change.key)) continue;
    crashInFlight.add(change.key);
    const name = `${channelById(change.key)?.name ?? "?"} ${pilotName(heat.slots.get(change.key)?.pilotId)}`;
    request(`/api/races/${encodeURIComponent(raceId)}/autocrash`, {
      method: "POST",
      body: JSON.stringify({ channelId: change.key, crashed: change.crashed }),
    })
      .then((result) => {
        applyState(result);
        log(change.crashed ? `${name}: video went still, marked crashed` : `${name}: moving again, back in the heat`, "pass");
      })
      .catch((error) => log(`${name}: ${error.message}`, "error"))
      .finally(() => crashInFlight.delete(change.key));
  }
};

const grabTick = () => {
  const now = Date.now();
  if (state != null) {
    for (const entry of tiles.values()) grabFrame(entry, now);
    if (settings.crashOut) runCrashOut(now);
  }
  setTimeout(grabTick, 1000 / clamp(Number(settings.detectionFps) || 30, 1, 60));
};

// ---- Drawing -----------------------------------------------------------------------

const drawPlaceholder = (entry) => {
  const { ctx, canvas } = entry;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#888";
  ctx.font = "600 22px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("No video. Pick a source below.", canvas.width / 2, canvas.height / 2);
  ctx.textAlign = "start";
};

const statusText = (entry) => {
  if (entry.source === "none") return "No video";
  const kinds = { test: "Test pattern", still: "Still picture", file: "Video file" };
  const parts = [kinds[entry.source] ?? "Camera"];
  if (entry.fps.fps > 0) parts.push(`${entry.fps.fps.toFixed(0)} checks/s`);
  if (Number.isFinite(entry.ratio)) parts.push(`signal ${entry.ratio.toFixed(2)}`);
  if (settings.crashOut && heat.running && heat.slots.has(entry.channel.id)) parts.push(MOTION_TEXT[entry.motionState]);
  if (entry.lastLap) parts.push(`last ${entry.lastLap}`);
  return parts.join(" · ");
};

const renderTile = (entry, now) => {
  const { ctx, canvas } = entry;
  if (entry.source === "none") drawPlaceholder(entry);
  else {
    if (entry.source === "test" || entry.source === "still") ctx.drawImage(entry.grab, 0, 0, canvas.width, canvas.height);
    else if (entry.video != null && entry.video.readyState >= 2) ctx.drawImage(entry.video, 0, 0, canvas.width, canvas.height);
    drawOverlay(ctx, {
      width: canvas.width,
      height: canvas.height,
      detectionWidth: FRAME_W,
      detectionHeight: FRAME_H,
      detections: entry.held.active(now),
      showBox: settings.showMarkerBox,
      showId: settings.showMarkerId,
      showSizePercent: settings.showMarkerSizePercent,
      showFps: settings.showFps,
      fps: entry.fps.fps,
      showSignalRatio: settings.showSignalRatio,
      signalRatio: entry.ratio,
      lostSignalThreshold: settings.lostSignalThreshold,
    });
  }
  if (now - entry.statusAt < 250) return;
  entry.statusAt = now;
  entry.status.textContent = statusText(entry);
  const inGate = heat.running && system.stateByFrequency.get(entry.channel.frequencyMhz)?.inGate === true;
  entry.gate.textContent = entry.blanked ? "Static" : inGate ? "In gate" : "Clear";
  entry.gate.dataset.on = String(inGate && !entry.blanked);
  entry.gate.dataset.alert = String(entry.blanked);
};

const render = () => {
  const now = Date.now();
  for (const entry of tiles.values()) renderTile(entry, now);
  requestAnimationFrame(render);
};

// ---- Settings panels -------------------------------------------------------------------

const renderCalibrationStatus = () => {
  const needsFile = calibration == null && settings.detectMode === "Corrected";
  calibrationStatus.classList.toggle("warning", needsFile);
  if (calibration != null) {
    calibrationStatus.textContent = `Loaded for ${calibration.referenceWidth}×${calibration.referenceHeight} with ${calibration.dist.length} distortion terms, scaled to the ${FRAME_W}×${FRAME_H} detection picture.`;
  } else if (needsFile) {
    calibrationStatus.textContent = "Corrected mode finds no markers without a calibration file. Load one, or switch to Original or Hybrid.";
  } else {
    calibrationStatus.textContent = "No calibration file. Hybrid works like Original until you load one.";
  }
};

const updateSetting = (field, input) => {
  let value;
  if (field.type === "check") value = input.checked;
  else if (field.type === "number") {
    const number = Number(input.value);
    value = Number.isFinite(number) ? clamp(number, field.min, field.max) : settings[field.key];
    input.value = String(value);
  } else value = input.value.trim();
  if (field.key === "markerIds") {
    const ids = effectiveMarkerIds(value);
    if (ids.length === 0) {
      input.value = settings.markerIds;
      setMessage("Enter at least one marker ID, such as 0.", true);
      return;
    }
    if (ids.some((id) => id < 0 || id > 49)) setMessage("Only IDs 0 to 49 exist in the 4x4 set; others are never seen.", true);
    else setMessage("Saved.");
  } else setMessage("Saved.");
  settings[field.key] = value;
  saveSettings();
  if (field.key === "useMultiThreadDetection") resetWorkers();
  if (field.key === "markerIds") renderSheetPreview();
  renderCalibrationStatus();
};

const fieldControl = (field) => {
  const label = element("label");
  let input;
  if (field.type === "select") {
    input = element("select");
    for (const option of field.options) {
      const choice = element("option", null, option);
      choice.value = option;
      input.append(choice);
    }
    input.value = settings[field.key];
  } else {
    input = element("input");
    input.type = field.type === "check" ? "checkbox" : field.type;
    if (field.type === "check") input.checked = settings[field.key] === true;
    else input.value = String(settings[field.key]);
    if (field.type === "number") Object.assign(input, { min: field.min, max: field.max, step: field.step });
  }
  input.name = field.key;
  input.addEventListener("change", () => updateSetting(field, input));
  if (field.type === "check") {
    label.className = "check";
    label.append(input, ` ${field.label}`);
  } else {
    label.append(field.label, input);
  }
  if (field.help != null) label.append(element("span", "field-help", field.help));
  return label;
};

const buildFields = () => {
  fieldsBox.replaceChildren();
  for (const group of FIELD_GROUPS) {
    const fieldset = element("fieldset", "fieldset");
    fieldset.append(element("legend", null, group.legend), ...group.fields.map(fieldControl));
    fieldsBox.append(fieldset);
  }
};

const sheetIds = () =>
  effectiveMarkerIds(sheetIdsInput.value.trim() || settings.markerIds).filter((id) => id >= 0 && id <= 49);

const renderSheetPreview = () => {
  sheetIdsInput.placeholder = settings.markerIds;
  sheetPreview.innerHTML = sheetIds()
    .map((id) => markerSvg(id, { sizeMm: 20, caption: false }))
    .join("");
};

$("#defaults").addEventListener("click", () => {
  Object.assign(settings, ARUCO_DEFAULTS, { detectionFps: PAGE_DEFAULTS.detectionFps, role: "Primary" });
  saveSettings();
  resetWorkers();
  buildFields();
  renderCalibrationStatus();
  renderSheetPreview();
  setMessage("Detection settings are back to FPVTrackside's defaults.");
});

$("#calibration-file").addEventListener("change", async (event) => {
  const picked = event.target.files?.[0];
  event.target.value = "";
  if (picked == null) return;
  const text = await picked.text();
  const parsed = parseCalibration(text);
  if (parsed.error != null) {
    setMessage(`Calibration not loaded: ${parsed.error}.`, true);
    return;
  }
  calibration = parsed.calibration;
  saveJson(CALIBRATION_KEY, JSON.parse(text));
  broadcastCalibration();
  renderCalibrationStatus();
  setMessage("Calibration loaded.");
  log(`Lens calibration loaded from ${picked.name}`);
});

$("#calibration-clear").addEventListener("click", () => {
  calibration = null;
  localStorage.removeItem(CALIBRATION_KEY);
  broadcastCalibration();
  renderCalibrationStatus();
  setMessage("Calibration removed.");
});

crashOn.checked = settings.crashOut === true;
crashDelay.value = String(settings.crashDelaySeconds);
crashOn.addEventListener("change", () => {
  settings.crashOut = crashOn.checked;
  saveSettings();
  if (settings.crashOut && heat.running) crash.raceStarted(Date.parse(heat.race.startedAt));
  setMessage(settings.crashOut ? "Still video now marks a pilot crashed." : "Crash marking is off.");
});
crashDelay.addEventListener("change", () => {
  const seconds = clamp(Number(crashDelay.value) || 0, 0, 60);
  crashDelay.value = String(seconds);
  settings.crashDelaySeconds = seconds;
  crash.startDelayMs = seconds * 1000;
  saveSettings();
});

sheetIdsInput.addEventListener("input", renderSheetPreview);
$("#sheet-print").addEventListener("click", () => {
  const ids = sheetIds();
  if (ids.length === 0) {
    setMessage("Pick marker IDs from 0 to 49 to print.", true);
    return;
  }
  const copies = clamp(Math.round(Number(sheetCopies.value) || 2), 1, 8);
  const sizeMm = clamp(Number(sheetSize.value) || 150, 40, 400);
  printSheet.innerHTML = ids
    .flatMap((id) => Array.from({ length: copies }, () => `<div class="print-page">${markerSvg(id, { sizeMm })}</div>`))
    .join("");
  window.print();
});

$("#allow-cameras").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach((track) => track.stop());
    await refreshDevices();
    setMessage(devices.length === 0 ? "No cameras found." : `${devices.length} camera${devices.length === 1 ? "" : "s"} ready to pick.`);
  } catch (error) {
    setMessage(`Camera access was not allowed (${error.message}).`, true);
  }
});

$("#all-test").addEventListener("click", () => {
  const ids = heat.slots.size > 0 ? [...heat.slots.keys()] : [...tiles.keys()];
  for (const channelId of ids) {
    const entry = tiles.get(channelId);
    if (entry == null) continue;
    setSource(entry, "test");
    fillSourceOptions(entry);
  }
  setMessage(`Test pattern on ${ids.length} channel${ids.length === 1 ? "" : "s"}.`);
});

navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);

const poll = async () => {
  try {
    applyState(await request("/api/state"));
    if (message.textContent.startsWith("The race desk")) setMessage("");
  } catch (error) {
    setMessage(`The race desk is not answering (${error.message}).`, true);
  }
  setTimeout(poll, 1000);
};

buildFields();
renderCalibrationStatus();
renderSheetPreview();
refreshDevices().catch(() => {});
poll();
grabTick();
requestAnimationFrame(render);

import { clockSeconds, formatSeconds } from "/clock.js";
import { heatTransitions } from "/obs.js";
import { mountObsPanel, obsHeatEvent } from "/obs-panel.js";
import { openReplay } from "/replay.js";

const title = document.querySelector("#event-title");
const stepText = document.querySelector("#step-text");
const steps = document.querySelector("#steps");
const settings = document.querySelector("#settings");
const modeSelect = document.querySelector("#mode");
const modeHelp = document.querySelector("#mode-help");
const lengthLabel = document.querySelector("#length-label");
const pilotForm = document.querySelector("#add-pilot");
const pilotList = document.querySelector("#pilot-list");
const packSelect = document.querySelector("#pack");
const packHelp = document.querySelector("#pack-help");
const addChannelSelect = document.querySelector("#add-channel");
const channelList = document.querySelector("#channel-list");
const stageList = document.querySelector("#stage-list");
const generate = document.querySelector("#generate");
const formatSelect = document.querySelector("#format");
const formatHelp = document.querySelector("#format-help");
const board = document.querySelector("#board");
const message = document.querySelector("#message");

const STEP_ORDER = [
  ["pilots", "Pilots"],
  ["format", "Draw"],
  ["start", "Start"],
  ["fly", "Gate"],
  ["next", "Next round"],
];

let state = null;
let audioContext = null;
const pendingTicks = new Set();
const hornsPlayed = new Set();

const CLOCK_SESSIONS = ["TimeTrial", "Endurance"];
const roundOf = (race) => state.event.rounds.find((round) => round.races.includes(race));

const setMessage = (text, isError = false) => {
  message.textContent = text ?? "";
  message.classList.toggle("error", isError);
};

const request = async (url, options) => {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed.");
  return body;
};

const pilotName = (id) => state.event.pilots.find((pilot) => pilot.id === id)?.name ?? "Pilot";
const channelOf = (id) => state.event.channels.find((channel) => channel.id === id);

const tone = (frequency, duration = 0.12, type = "sine") => {
  if (state?.event.sound !== true) return;
  const context = audioContext ??= new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.value = 0.05;
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
  oscillator.stop(context.currentTime + duration);
};

const applyTheme = () => {
  document.body.dataset.theme = state.event.theme ?? "night";
};

const fillSettings = () => {
  if (settings.contains(document.activeElement)) return;
  const event = state.event;
  settings.elements.name.value = event.name;
  settings.elements.laps.value = String(event.laps);
  settings.elements.pbLaps.value = String(event.pbLaps);
  settings.elements.maxPilotsPerRace.value = String(event.maxPilotsPerRace);
  settings.elements.raceLengthSeconds.value = String(event.raceLengthSeconds ?? 120);
  settings.elements.holeshot.checked = event.holeshot !== false;
  settings.elements.sound.checked = event.sound !== false;
  settings.elements.captions.checked = event.captions !== false;
  settings.elements.theme.value = event.theme ?? "night";
  settings.elements.mode.value = event.mode ?? "Race";
  const rules = state.rules;
  settings.elements.minLapSeconds.value = String(rules.minLapSeconds);
  settings.elements.startIgnoreSeconds.value = String(rules.startIgnoreSeconds);
  settings.elements.startDelayMinSeconds.value = String(rules.startDelayMinSeconds);
  settings.elements.startDelayMaxSeconds.value = String(rules.startDelayMaxSeconds);
  settings.elements.positionPoints.value = rules.points.positionPoints.join(", ");
  settings.elements.dnfPoints.value = String(rules.points.dnfPoints);
  settings.elements.dnfForUnfinishedRaces.checked = rules.points.dnfForUnfinishedRaces;
  title.textContent = event.name;
  lengthLabel.hidden = !CLOCK_SESSIONS.includes(event.mode);
  modeHelp.textContent = state.modes.find((mode) => mode.id === event.mode)?.detail ?? "";
};

const renderSteps = () => {
  steps.replaceChildren();
  for (const [id, label] of STEP_ORDER) {
    const item = document.createElement("li");
    item.textContent = label;
    item.dataset.on = String(state.step.id === id);
    steps.append(item);
  }
  stepText.textContent = `${state.step.title}. ${state.step.text}`;
};

const renderModes = () => {
  if (modeSelect.options.length > 0) return;
  for (const mode of state.modes) {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.title;
    modeSelect.append(option);
  }
};

const renderPilots = () => {
  pilotList.replaceChildren();
  for (const pilot of state.event.pilots) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = pilot.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tiny";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => act(() => request(`/api/pilots/${pilot.id}`, { method: "DELETE" })));
    item.append(name, remove);
    pilotList.append(item);
  }
};

const renderPacks = () => {
  if (packSelect.options.length > 0) return;
  for (const pack of state.packs) {
    const option = document.createElement("option");
    option.value = pack.id;
    option.textContent = pack.title;
    option.dataset.detail = pack.detail;
    packSelect.append(option);
  }
  packHelp.textContent = packSelect.selectedOptions[0]?.dataset.detail ?? "";
};

const renderChannels = () => {
  channelList.replaceChildren();
  const sorted = [...state.event.channels].sort((left, right) => left.frequencyMhz - right.frequencyMhz);
  for (const channel of sorted) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = channel.color;
    name.append(swatch, ` ${channel.name} · ${channel.frequencyMhz} MHz`);
    const band = document.createElement("span");
    band.className = "meta";
    band.textContent = channel.bandTitle ?? channel.band;
    item.append(name, band);
    if (channel.catalogId != null) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tiny";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => act(() => request("/api/channels/toggle", {
        method: "POST",
        body: JSON.stringify({ catalogId: channel.catalogId, on: false }),
      })));
      item.append(remove);
    }
    channelList.append(item);
  }
  const present = new Set(state.event.channels.map((channel) => channel.catalogId));
  const groups = new Map();
  for (const entry of state.catalog) {
    if (present.has(entry.catalogId)) continue;
    if (!groups.has(entry.bandTitle)) groups.set(entry.bandTitle, []);
    groups.get(entry.bandTitle).push(entry);
  }
  const selected = addChannelSelect.value;
  addChannelSelect.replaceChildren();
  for (const [bandTitle, entries] of groups) {
    const group = document.createElement("optgroup");
    group.label = bandTitle;
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = String(entry.catalogId);
      option.textContent = `${entry.name} · ${entry.frequencyMhz} MHz`;
      group.append(option);
    }
    addChannelSelect.append(group);
  }
  if ([...addChannelSelect.options].some((option) => option.value === selected)) addChannelSelect.value = selected;
};

const renderStages = () => {
  stageList.replaceChildren();
  for (const stage of [...state.event.stages].sort((left, right) => left.order - right.order)) {
    const item = document.createElement("li");
    item.className = "stage-row";
    const name = document.createElement("strong");
    name.textContent = stage.name;
    const next = stage.id === state.event.activeStageId;
    const target = next
      ? Object.assign(document.createElement("span"), { className: "meta", textContent: "next" })
      : actionButton("Use for next round", () => request(`/api/stages/${stage.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
      }), null, "tiny");
    const summary = stage.pointSummary ?? null;
    const toggle = (label, checked, patch) => {
      const wrap = document.createElement("label");
      wrap.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = checked;
      box.addEventListener("change", () => act(() => request(`/api/stages/${stage.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch(box.checked)),
      })));
      wrap.append(box, ` ${label}`);
      return wrap;
    };
    const options = document.createElement("div");
    options.className = "stack";
    options.append(toggle("Points summary for this stage", summary != null, (on) => ({ pointSummary: on ? {} : null })));
    if (summary != null) {
      options.append(
        toggle("Drop each pilot’s worst round", summary.dropWorstRound, (on) => ({ pointSummary: { dropWorstRound: on } })),
        toggle("Carry places from the stage before", summary.roundPositionRollover, (on) => ({ pointSummary: { roundPositionRollover: on } })),
      );
    }
    const head = document.createElement("div");
    head.className = "seat-main";
    head.append(name, target);
    item.append(head, options);
    stageList.append(item);
  }
};

const formatDescription = (format) => {
  if (format == null) return "";
  if (format.error) return `${format.file} cannot draw rounds: ${format.error}`;
  const by = format.author ? ` By ${format.author}.` : "";
  const from = format.script ? ` From scripts/${format.file}.` : "";
  return `${format.description ?? ""}${by}${from}`.trim();
};

const renderFormats = () => {
  const signature = state.formats.map((format) => `${format.id}:${format.error ?? ""}`).join("|");
  if (formatSelect.dataset.signature === signature) return;
  const selected = formatSelect.value;
  formatSelect.replaceChildren();
  const builtIn = document.createElement("optgroup");
  builtIn.label = "Built-in formats";
  const scripts = document.createElement("optgroup");
  scripts.label = "Lua scripts";
  for (const format of state.formats) {
    const option = document.createElement("option");
    option.value = format.id;
    option.textContent = format.error ? `${format.name} (needs fixing)` : format.name;
    option.disabled = Boolean(format.error);
    (format.script ? scripts : builtIn).append(option);
  }
  formatSelect.append(builtIn);
  if (scripts.childElementCount > 0) formatSelect.append(scripts);
  formatSelect.dataset.signature = signature;
  if ([...formatSelect.options].some((option) => option.value === selected && !option.disabled)) formatSelect.value = selected;
  formatHelp.textContent = formatDescription(state.formats.find((format) => format.id === formatSelect.value));
};

const scoring = (slot) => slot.laps.filter((lap) => lap.number > 0);
const bestOf = (laps) => laps.reduce((min, lap) => Math.min(min, lap.lengthSeconds), Number.POSITIVE_INFINITY);

const renderBoard = () => {
  board.replaceChildren();
  if (state.event.rounds.length === 0) {
    const empty = document.createElement("div");
    empty.className = "stack";
    empty.append(heading("The live heat appears here"), paragraph(state.step.text));
    board.append(empty);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "rounds";
  for (const round of state.event.rounds) {
    const block = document.createElement("section");
    block.className = "stack";
    const stage = state.event.stages.find((item) => item.id === round.stageId);
    block.append(heading(`${stage?.name ?? "Main"} · ${round.name} · ${round.eventType} round ${round.number}`));
    for (const race of round.races) block.append(renderRace(round, race));
    wrap.append(block);
  }
  board.append(wrap);
  if (state.event.captions !== false && state.captions?.length) {
    const log = document.createElement("section");
    log.className = "stack";
    const list = document.createElement("div");
    list.className = "captions";
    for (const line of state.captions) {
      const row = document.createElement("p");
      row.textContent = line.text;
      list.append(row);
    }
    log.append(heading("Gate log"), list);
    board.append(log);
  }
  if (state.board != null) {
    const table = document.createElement("section");
    table.className = "stack";
    table.append(heading(state.board.title));
    table.append(dataTable(["Pilot", ...state.board.headings], state.board.rows.map((row) => [row.name, ...row.values])));
    board.append(table);
  }
  for (const standing of state.standings ?? []) {
    const section = document.createElement("section");
    section.className = "stack";
    const notes = [];
    if (standing.summary?.dropWorstRound) notes.push("worst round dropped");
    if (standing.summary?.roundPositionRollover) notes.push("places carried in");
    section.append(heading(`${standing.name} points${notes.length ? ` · ${notes.join(", ")}` : ""}`));
    section.append(dataTable(["Place", "Pilot", "Total"], standing.rows.map((row) => [String(row.position), row.name, String(row.total)])));
    board.append(section);
  }
};

const heading = (text) => {
  const node = document.createElement("h2");
  node.textContent = text;
  return node;
};

const paragraph = (text) => {
  const node = document.createElement("p");
  node.className = "help";
  node.textContent = text;
  return node;
};

const dataTable = (headings, rows) => {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of headings) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const row of rows) {
    const line = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      cell.textContent = value;
      line.append(cell);
    }
    table.append(line);
  }
  return table;
};

const renderRace = (round, race) => {
  const section = document.createElement("article");
  section.className = "race";
  section.dataset.raceId = race.id;
  const head = document.createElement("div");
  head.className = "race-head";
  const name = document.createElement("h3");
  const bracket = race.bracket === "None" ? "" : ` · ${race.bracket}`;
  name.textContent = `Heat ${round.number}-${race.number}${bracket}`;
  const clock = document.createElement("span");
  clock.className = "clock";
  clock.dataset.raceId = race.id;
  const actions = document.createElement("div");
  actions.className = "slot-actions";
  actions.append(actionButton(state.event.sound === false ? "Sound on" : "Mute", () => request("/api/event", {
    method: "PATCH",
    body: JSON.stringify({ sound: state.event.sound === false }),
  }), null, "secondary"));
  if (race.startedAt == null) {
    actions.append(actionButton("Start the clock", () => request(`/api/races/${race.id}/start`, { method: "POST", body: "{}" }), () => {
      tone(330, 0.12);
    }));
  } else if (race.endedAt == null && race.pausedAt != null) {
    actions.append(
      actionButton("Resume", () => request(`/api/races/${race.id}/resume`, { method: "POST", body: "{}" })),
      actionButton("Emergency stop", () => request(`/api/races/${race.id}/emergency`, { method: "POST", body: "{}" }), () => tone(90, 0.45, "sawtooth"), "secondary"),
    );
  } else if (race.endedAt == null) {
    actions.append(
      actionButton("Pause", () => request(`/api/races/${race.id}/pause`, { method: "POST", body: "{}" }), () => tone(220, 0.08), "secondary"),
      actionButton(round.eventType === "Freestyle" || round.eventType === "CasualPractice" ? "Close session" : "Call finish", () => request(`/api/races/${race.id}/finish`, { method: "POST", body: "{}" }), () => tone(520, 0.3)),
      actionButton("Emergency stop", () => request(`/api/races/${race.id}/emergency`, { method: "POST", body: "{}" }), () => tone(90, 0.45, "sawtooth"), "secondary"),
    );
  } else {
    const done = document.createElement("span");
    done.className = "meta";
    done.textContent = race.emergency ? "Emergency stop" : "Result is in";
    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "secondary";
    replay.textContent = "Replay";
    replay.addEventListener("click", () => openReplay({
      race,
      title: `Heat ${round.number}-${race.number}`,
      nameOf: pilotName,
      channelOf,
    }));
    actions.append(done, replay);
  }
  if (race.startedAt != null || race.endedAt != null) {
    actions.append(actionButton("Restart heat", async () => {
      if (!confirm("Clear this heat and fly it again?")) return state;
      return request(`/api/races/${race.id}/restart`, { method: "POST", body: "{}" });
    }, null, "secondary"));
  }
  head.append(name, clock, actions);
  const seats = document.createElement("div");
  seats.className = "seats";
  race.slots.forEach((slot, index) => seats.append(renderSeat(race, slot, index)));
  const hints = {
    Game: "Keys 1–8 give that seat a game point while you are not typing in a box.",
    Freestyle: "Freestyle has no gate timing. Close the session when the pack lands.",
  };
  const hint = paragraph(hints[round.eventType] ?? "Keys 1–8 call the gate for that seat while you are not typing in a box.");
  section.append(head, seats, hint);
  return section;
};

const renderSeat = (race, slot, index) => {
  const row = document.createElement("div");
  row.className = "seat";
  const channel = channelOf(slot.channelId);
  row.style.setProperty("--channel", channel?.color ?? "#d5d8de");
  const main = document.createElement("div");
  main.className = "seat-main";
  const who = document.createElement("strong");
  who.textContent = `${index + 1}. ${pilotName(slot.pilotId)} · ${channel?.name ?? ""} ${channel?.frequencyMhz ?? ""}`;
  const eventType = roundOf(race)?.eventType ?? "Race";
  const laps = scoring(slot);
  const hole = slot.laps.find((lap) => lap.number === 0);
  const best = bestOf(laps);
  const status = slot.position == null ? "" : `  P${slot.position}${slot.points ? ` · ${slot.points} pts` : ""}`;
  const flag = slot.crashed ? "  Crashed" : slot.dnf || slot.resultDnf ? "  DNF" : "";
  const times = document.createElement("span");
  times.className = "times";
  const lapLimit = eventType === "Race" ? `/${race.targetLaps}` : "";
  times.textContent = eventType === "Game"
    ? `${slot.gamePoints?.length ?? 0} game points${status}${flag}`
    : `HS ${formatSeconds(hole?.lengthSeconds)} · ${laps.length}${lapLimit} laps · last ${formatSeconds(laps.at(-1)?.lengthSeconds)} · best ${Number.isFinite(best) ? formatSeconds(best) : "—"}${status}${flag}`;
  main.append(who, times);
  const actions = document.createElement("div");
  actions.className = "slot-actions";
  const horn = race.startedAt != null && Date.now() >= Date.parse(race.startedAt);
  const running = horn && race.endedAt == null && race.pausedAt == null && !slot.dnf && !slot.crashed;
  const room = eventType === "Race" ? laps.length < race.targetLaps : eventType !== "Freestyle";
  if (running && room) {
    actions.append(actionButton(`${eventType === "Game" ? "Point" : "Lap"} ${index + 1}`, () => request(`/api/races/${race.id}/lap`, {
      method: "POST",
      body: JSON.stringify({ pilotId: slot.pilotId }),
    }), () => {
      const updated = state.event.rounds.flatMap((item) => item.races).flatMap((item) => item.slots)
        .find((item) => item.pilotId === slot.pilotId);
      const flown = updated?.laps.filter((lap) => lap.number > 0).length ?? 0;
      if (flown >= race.targetLaps) tone(1240, 0.14);
      else tone(880, 0.05, "square");
    }, "lap"));
    actions.append(actionButton("DNF", () => request(`/api/races/${race.id}/dnf`, {
      method: "POST",
      body: JSON.stringify({ pilotId: slot.pilotId }),
    }), () => tone(160, 0.2), "tiny"));
    actions.append(actionButton("Crashed", () => request(`/api/races/${race.id}/crash`, {
      method: "POST",
      body: JSON.stringify({ pilotId: slot.pilotId }),
    }), () => tone(110, 0.25, "sawtooth"), "tiny"));
  }
  if (slot.laps.length > 0 || (slot.gamePoints?.length ?? 0) > 0 || slot.dnf || slot.crashed) {
    actions.append(actionButton("Undo", () => request(`/api/races/${race.id}/undo`, {
      method: "POST",
      body: JSON.stringify({ pilotId: slot.pilotId }),
    }), null, "tiny"));
  }
  row.append(main, actions);
  return row;
};

const actionButton = (label, run, sound, className) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className != null) button.className = className;
  button.addEventListener("click", () => act(run, sound));
  return button;
};

const adopt = (next) => {
  const before = state;
  state = next;
  for (const transition of heatTransitions(before, next)) obsHeatEvent(transition.kind);
};

const act = async (run, sound) => {
  try {
    adopt(await run());
    sound?.();
    setMessage(state.stop ?? state.note ?? "");
    render();
  } catch (error) {
    setMessage(error.message, true);
  }
};

const render = () => {
  const active = state.event.stages.find((stage) => stage.id === state.event.activeStageId);
  document.querySelector("#stage-now").textContent = `The next round joins ${active?.name ?? "Main"}.`;
  applyTheme();
  renderModes();
  fillSettings();
  renderSteps();
  renderPilots();
  renderPacks();
  renderChannels();
  renderStages();
  renderFormats();
  renderBoard();
  tickClocks();
};

const tickClocks = () => {
  let hornNow = false;
  for (const clock of board.querySelectorAll(".clock")) {
    const race = state.event.rounds.flatMap((round) => round.races).find((candidate) => candidate.id === clock.dataset.raceId);
    if (race == null || race.startedAt == null) {
      clock.textContent = "Ready";
      continue;
    }
    const start = Date.parse(race.startedAt);
    if (race.endedAt == null && Date.now() < start) {
      clock.textContent = "Get ready…";
      continue;
    }
    if (race.endedAt == null && !hornsPlayed.has(race.id)) {
      hornsPlayed.add(race.id);
      if (Date.now() - start < 2000) {
        tone(660, 0.45, "square");
        hornNow = true;
      }
    }
    const seconds = clockSeconds(race);
    const timed = CLOCK_SESSIONS.includes(roundOf(race)?.eventType);
    if (timed && race.endedAt == null) {
      const left = (race.raceLengthSeconds ?? 0) - seconds;
      clock.textContent = race.pausedAt != null ? `Paused ${formatSeconds(Math.max(0, left))} left` : formatSeconds(Math.max(0, left));
      if (left <= 0 && race.pausedAt == null && !pendingTicks.has(race.id)) {
        pendingTicks.add(race.id);
        act(() => request(`/api/races/${race.id}/tick`, { method: "POST", body: "{}" }), () => tone(520, 0.3))
          .finally(() => pendingTicks.delete(race.id));
      }
    } else {
      clock.textContent = race.pausedAt != null ? `Paused ${formatSeconds(seconds)}` : formatSeconds(seconds);
    }
  }
  if (hornNow) {
    renderBoard();
    obsHeatEvent("horn");
  }
};

settings.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(settings);
  act(() => request("/api/event", {
    method: "PATCH",
    body: JSON.stringify({
      name: data.get("name"),
      laps: Number(data.get("laps")),
      pbLaps: Number(data.get("pbLaps")),
      maxPilotsPerRace: Number(data.get("maxPilotsPerRace")),
      raceLengthSeconds: Number(data.get("raceLengthSeconds")),
      mode: data.get("mode"),
      theme: data.get("theme"),
      sound: data.get("sound") === "on",
      holeshot: data.get("holeshot") === "on",
      captions: data.get("captions") === "on",
      minLapSeconds: Number(data.get("minLapSeconds")),
      startIgnoreSeconds: Number(data.get("startIgnoreSeconds")),
      startDelayMinSeconds: Number(data.get("startDelayMinSeconds")),
      startDelayMaxSeconds: Number(data.get("startDelayMaxSeconds")),
      positionPoints: data.get("positionPoints"),
      dnfPoints: Number(data.get("dnfPoints")),
      dnfForUnfinishedRaces: data.get("dnfForUnfinishedRaces") === "on",
    }),
  }));
});

modeSelect.addEventListener("change", () => {
  lengthLabel.hidden = !CLOCK_SESSIONS.includes(modeSelect.value);
  modeHelp.textContent = state?.modes.find((mode) => mode.id === modeSelect.value)?.detail ?? "";
});

packSelect.addEventListener("change", () => {
  packHelp.textContent = packSelect.selectedOptions[0]?.dataset.detail ?? "";
});

document.querySelector("#use-pack").addEventListener("click", () => {
  act(() => request("/api/channels", { method: "POST", body: JSON.stringify({ pack: packSelect.value }) }));
});

document.querySelector("#add-channel-button").addEventListener("click", () => {
  if (addChannelSelect.value === "") return;
  act(() => request("/api/channels/toggle", {
    method: "POST",
    body: JSON.stringify({ catalogId: Number(addChannelSelect.value), on: true }),
  }));
});

settings.elements.theme.addEventListener("change", () => {
  document.body.dataset.theme = settings.elements.theme.value;
});

pilotForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = new FormData(pilotForm).get("name");
  act(async () => {
    const next = await request("/api/pilots", { method: "POST", body: JSON.stringify({ name }) });
    pilotForm.reset();
    return next;
  });
});

document.querySelector("#paste-pilots").addEventListener("click", () => {
  const text = document.querySelector("#bulk-pilots").value;
  act(async () => {
    const next = await request("/api/pilots/paste", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    document.querySelector("#bulk-pilots").value = "";
    return next;
  });
});

document.querySelector("#copy-pilots").addEventListener("click", async () => {
  const text = state.event.pilots.map((pilot) => pilot.name).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    setMessage(text === "" ? "There are no pilots to copy." : "Pilot list copied.");
  } catch {
    setMessage(text === "" ? "There are no pilots to copy." : text);
  }
});

document.querySelector("#new-stage").addEventListener("click", () => {
  const name = document.querySelector("#stage-name").value;
  act(async () => {
    const next = await request("/api/stages", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    document.querySelector("#stage-name").value = "";
    return next;
  });
});

document.querySelector("#sample").addEventListener("click", () => {
  act(() => request("/api/sample", { method: "POST", body: "{}" }));
});

generate.addEventListener("submit", (event) => {
  event.preventDefault();
  act(() => request("/api/rounds", {
    method: "POST",
    body: JSON.stringify({ format: formatSelect.value }),
  }));
});

formatSelect.addEventListener("change", () => {
  formatHelp.textContent = formatDescription(state.formats.find((format) => format.id === formatSelect.value));
});

document.querySelector("#script-file").addEventListener("change", async (event) => {
  const input = event.target;
  const file = input.files?.[0];
  if (file == null) return;
  const source = await file.text();
  await act(() => request("/api/scripts", { method: "POST", body: JSON.stringify({ file: file.name, source }) }));
  input.value = "";
});

document.querySelector("#remove-round").addEventListener("click", () => {
  act(() => request("/api/rounds/latest", { method: "DELETE" }));
});

document.querySelector("#reset").addEventListener("click", () => {
  if (!confirm("Clear this meet and start again?")) return;
  act(() => request("/api/reset", { method: "POST", body: "{}" }));
});

document.querySelector("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state.event, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "club-meet.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  const digit = Number(event.key);
  if (!Number.isInteger(digit) || digit < 1 || digit > 8) return;
  const race = state?.event.rounds.flatMap((round) => round.races).find((candidate) =>
    candidate.startedAt != null && Date.now() >= Date.parse(candidate.startedAt) && candidate.endedAt == null && candidate.pausedAt == null);
  const slot = race?.slots[digit - 1];
  if (slot == null) return;
  event.preventDefault();
  act(() => request(`/api/races/${race.id}/lap`, {
    method: "POST",
    body: JSON.stringify({ pilotId: slot.pilotId }),
  }), () => tone(880, 0.05, "square"));
});

const refresh = async () => {
  try {
    const next = await request("/api/state");
    if (state == null || next.event.updatedAt !== state.event.updatedAt) {
      adopt(next);
      render();
    } else {
      tickClocks();
    }
  } catch (error) {
    setMessage(error.message, true);
  }
};

mountObsPanel(document.querySelector("#obs-panel"));
refresh();
setInterval(tickClocks, 200);
setInterval(refresh, 1000);

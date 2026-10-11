import { clockSeconds, formatSeconds } from "/clock.js";
import { openReplay } from "/replay.js";
import { lapLengthMeters, speedKmh } from "/track.js";
import { drawTrack } from "/track-view.js";

const title = document.querySelector("#event-title");
const tabs = document.querySelector("#tabs");
const view = document.querySelector("#view");
const pages = ["Event status", "Rounds", "Lap records", "Lap counts", "Points", "Pilots", "Track"];
let page = pages[0];
let state = null;

const pilotName = (id) => state.event.pilots.find((pilot) => pilot.id === id)?.name ?? "Pilot";
const channelOf = (id) => state.event.channels.find((channel) => channel.id === id);
const scoring = (slot) => slot.laps.filter((lap) => lap.number > 0);

const table = (headings, rows) => {
  const element = document.createElement("table");
  const head = document.createElement("tr");
  for (const heading of headings) {
    const cell = document.createElement("th");
    cell.textContent = heading;
    head.append(cell);
  }
  element.append(head);
  for (const row of rows) {
    const line = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      cell.textContent = value ?? "—";
      line.append(cell);
    }
    element.append(line);
  }
  return element;
};

const text = (tag, value) => {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
};

const renderTabs = () => {
  const selected = page;
  tabs.replaceChildren();
  for (const name of pages) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.setAttribute("aria-selected", String(name === selected));
    button.addEventListener("click", () => {
      page = name;
      render();
    });
    tabs.append(button);
  }
};

const maxLapColumns = (race) => Math.max(0, ...race.slots.map((slot) => scoring(slot).length));

const renderStatus = () => {
  const grid = document.createElement("div");
  grid.className = "status-grid";
  for (const key of ["previous", "current", "next"]) {
    const card = document.createElement("article");
    card.className = "status-card";
    const entry = state.cursor[key];
    card.append(
      text("h3", key[0].toUpperCase() + key.slice(1)),
      text("p", entry == null ? "—" : `${entry.roundName} ${entry.roundNumber}-${entry.raceNumber}`),
    );
    grid.append(card);
  }
  const wrap = document.createElement("div");
  wrap.className = "stack";
  wrap.append(grid);
  const current = state.event.rounds.flatMap((round) => round.races.map((race) => ({ round, race })))
    .find((entry) => entry.race.id === state.cursor.current?.raceId);
  if (current != null) {
    wrap.append(renderRaceTable(current.round, current.race), chart(current.race), positionChart(current.race));
  } else {
    wrap.append(text("p", "No live heat. The card below is the standby pattern."), testPattern());
  }
  if (state.event.captions !== false && state.captions?.length) {
    const log = document.createElement("div");
    log.className = "captions";
    for (const line of state.captions.slice(-8)) log.append(text("p", line.text));
    wrap.append(text("h2", "Gate log"), log);
  }
  return wrap;
};

const testPattern = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 160;
  const context = canvas.getContext("2d");
  const colors = ["#e23b3b", "#3b7de0", "#e0b43b", "#3cbe73", "#d45bd0", "#e07a32", "#f6f1e7", "#111"];
  colors.forEach((color, index) => {
    context.fillStyle = color;
    context.fillRect(index * (canvas.width / colors.length), 0, canvas.width / colors.length, canvas.height);
  });
  return canvas;
};

const positionChart = (race) => {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 280;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const start = Date.parse(race.startedAt ?? "");
  if (!Number.isFinite(start)) return canvas;
  const events = [];
  for (const slot of race.slots) {
    for (const lap of scoring(slot)) {
      events.push({ at: Date.parse(lap.endedAt), pilotId: slot.pilotId });
    }
  }
  events.sort((left, right) => left.at - right.at);
  const counts = new Map(race.slots.map((slot) => [slot.pilotId, 0]));
  const series = new Map(race.slots.map((slot) => [slot.pilotId, []]));
  for (const event of events) {
    counts.set(event.pilotId, (counts.get(event.pilotId) ?? 0) + 1);
    const order = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    order.forEach(([pilotId], index) => {
      series.get(pilotId).push({ x: (event.at - start) / 1000, y: index + 1 });
    });
  }
  const maxX = Math.max(1, ...events.map((event) => (event.at - start) / 1000));
  const maxY = Math.max(1, race.slots.length);
  const plot = (x, y) => [40 + (x / maxX) * 820, 30 + ((y - 1) / Math.max(1, maxY - 1)) * 210];
  context.strokeStyle = "#3a322a";
  context.strokeRect(40, 30, 820, 210);
  for (const slot of race.slots) {
    const points = series.get(slot.pilotId) ?? [];
    context.strokeStyle = channelOf(slot.channelId)?.color ?? "#f0b429";
    context.beginPath();
    points.forEach((point, index) => {
      const [x, y] = plot(point.x, point.y);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  context.fillStyle = "#c3b7a4";
  context.font = "16px Segoe UI";
  context.fillText("Place as laps are called. 1 is the top of the chart.", 40, 24);
  return canvas;
};

const renderRaceTable = (round, race) => {
  const columns = maxLapColumns(race);
  const headings = ["Place", "Pilot", "Channel", "Holeshot", ...Array.from({ length: columns }, (_, index) => `Lap ${index + 1}`), "Best lap", "Status"];
  const rows = race.slots.map((slot) => {
    const laps = scoring(slot);
    const hole = slot.laps.find((lap) => lap.number === 0);
    const best = laps.reduce((min, lap) => Math.min(min, lap.lengthSeconds), Number.POSITIVE_INFINITY);
    const padded = laps.map((lap) => formatSeconds(lap.lengthSeconds));
    while (padded.length < columns) padded.push("—");
    return [
      slot.position == null ? "" : String(slot.position),
      pilotName(slot.pilotId),
      channelOf(slot.channelId)?.name ?? "",
      formatSeconds(hole?.lengthSeconds),
      ...padded,
      Number.isFinite(best) ? formatSeconds(best) : "—",
      slot.crashed ? "Crashed" : slot.dnf ? "DNF" : "",
    ];
  });
  const block = document.createElement("div");
  block.className = "stack";
  const clock = clockSeconds(race);
  const line = document.createElement("p");
  line.dataset.clock = race.id;
  const clockLabel = race.pausedAt != null
    ? `Paused ${formatSeconds(clock)}`
    : round.eventType === "Endurance" && race.endedAt == null
      ? `Time left ${formatSeconds((race.raceLengthSeconds ?? 0) - clock)}`
      : `Clock ${race.startedAt == null ? "ready" : formatSeconds(clock)}`;
  line.textContent = clockLabel;
  block.append(text("h2", `${round.eventType} ${round.number}-${race.number}`), line, table(headings, rows));
  if (race.endedAt != null) {
    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "secondary";
    replay.textContent = "Replay this heat";
    replay.addEventListener("click", () => openReplay({
      race,
      title: `${round.eventType} ${round.number}-${race.number}`,
      nameOf: pilotName,
      channelOf,
    }));
    block.append(replay);
  }
  return block;
};

const chart = (race) => {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 280;
  const context = canvas.getContext("2d");
  const start = Date.parse(race.startedAt ?? "");
  context.fillStyle = "#0000";
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!Number.isFinite(start)) {
    context.fillStyle = "#c3b7a4";
    context.font = "16px Segoe UI";
    context.fillText("The lap chart appears once the clock starts.", 16, 40);
    return canvas;
  }
  const series = race.slots.map((slot) => ({
    color: channelOf(slot.channelId)?.color ?? "#f0b429",
    name: pilotName(slot.pilotId),
    points: slot.laps
      .filter((lap) => lap.number > 0)
      .map((lap, index) => ({ x: (Date.parse(lap.endedAt) - start) / 1000, y: index + 1 })),
  }));
  const maxX = Math.max(1, ...series.flatMap((item) => item.points.map((point) => point.x)));
  const maxY = Math.max(1, ...series.flatMap((item) => item.points.map((point) => point.y)));
  const plot = (x, y) => [40 + (x / maxX) * 820, 250 - (y / maxY) * 210];
  context.strokeStyle = "#3a322a";
  context.strokeRect(40, 40, 820, 210);
  for (const item of series) {
    context.strokeStyle = item.color;
    context.lineWidth = 2;
    context.beginPath();
    item.points.forEach((point, index) => {
      const [x, y] = plot(point.x, point.y);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
  return canvas;
};

const renderRounds = () => {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  if (state.event.rounds.length === 0) wrap.append(text("p", "No rounds yet. They show up here after the desk generates one."));
  for (const round of state.event.rounds) {
    const stage = state.event.stages?.find((item) => item.id === round.stageId);
    wrap.append(text("h2", `${stage?.name ?? "Main"} · ${round.eventType} round ${round.number} · ${round.name}`));
    for (const race of round.races) wrap.append(renderRaceTable(round, race));
  }
  return wrap;
};

const renderRecords = () => {
  const meters = state.event.track ? lapLengthMeters(state.event.track) : 0;
  const speed = (seconds) => {
    const kmh = speedKmh(meters, seconds);
    return kmh == null ? "—" : `${kmh} km/h`;
  };
  return table(
    ["Pilot", "Holeshot", "Best lap", ...(meters > 0 ? ["Best lap speed"] : []), `Best ${state.event.pbLaps}`, `Best ${state.event.laps}`, "Full race"],
    state.records.map((record) => [
      record.name,
      formatSeconds(record.holeshot),
      formatSeconds(record.bestLap),
      ...(meters > 0 ? [speed(record.bestLap)] : []),
      formatSeconds(record.pb),
      formatSeconds(record.target),
      formatSeconds(record.race),
    ]),
  );
};

const renderTrack = () => {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  const track = state.event.track;
  if (track == null || track.pieces.length === 0) {
    wrap.append(text("p", "No track map yet. The race desk can draw one from Track map."));
    return wrap;
  }
  const meters = lapLengthMeters(track);
  wrap.append(text("h2", meters > 0 ? `One lap is about ${meters} m` : "Track map"));
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = Math.round((1200 * track.depthMeters) / track.widthMeters);
  drawTrack(canvas, track, { showGrid: false });
  wrap.append(canvas);
  return wrap;
};

const renderCounts = () => {
  const headings = ["Pilot", ...state.event.rounds.map((round) => `R${round.number}`), "Total"];
  const rows = [...state.lapCounts]
    .sort((left, right) => right.total - left.total)
    .map((row) => [row.name, ...state.event.rounds.map((round) => String(row.rounds[round.id] ?? 0)), String(row.total)]);
  return table(headings, rows);
};

const renderPoints = () => {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  const roundName = (roundId) => {
    const round = state.event.rounds.find((item) => item.id === roundId);
    return round == null ? "" : `R${round.number}`;
  };
  if ((state.standings ?? []).length === 0) {
    wrap.append(text("p", "Points appear after the first race or endurance heat has a result."));
  }
  for (const standing of state.standings ?? []) {
    const carried = standing.summary?.roundPositionRollover === true;
    const headings = [
      "Place",
      "Pilot",
      "Bracket",
      ...(carried ? ["Carried"] : []),
      ...standing.roundIds.map(roundName),
      "Total",
    ];
    const rows = standing.rows.map((row) => {
      const mark = (value, dropped) => (value == null ? "" : dropped ? `(${value})` : String(value));
      return [
        String(row.position),
        row.name,
        row.bracket === "None" ? "" : row.bracket,
        ...(carried ? [mark(row.rollover?.points, row.dropped === "rollover")] : []),
        ...standing.roundIds.map((roundId) => mark(row.rounds[roundId], row.dropped === roundId)),
        String(row.total),
      ];
    });
    const notes = [];
    if (standing.summary?.dropWorstRound) notes.push("each pilot’s worst result is dropped, shown in brackets");
    if (carried) notes.push("places from the stage before are carried in");
    wrap.append(text("h2", `${standing.name} points`));
    if (notes.length > 0) wrap.append(text("p", `This stage has a points summary: ${notes.join(", and ")}.`));
    wrap.append(table(headings, rows));
  }
  if (state.board != null) {
    wrap.append(text("h2", state.board.title), table(["Pilot", ...state.board.headings], state.board.rows.map((row) => [row.name, ...row.values])));
  }
  return wrap;
};

const render = () => {
  document.body.dataset.theme = state.event.theme ?? "night";
  title.textContent = state.event.name;
  renderTabs();
  view.replaceChildren();
  if (page === "Event status") view.append(renderStatus());
  if (page === "Rounds") view.append(renderRounds());
  if (page === "Lap records") view.append(renderRecords());
  if (page === "Lap counts") view.append(renderCounts());
  if (page === "Points") view.append(renderPoints());
  if (page === "Pilots") view.append(renderPilots());
  if (page === "Track") view.append(renderTrack());
};

const renderPilots = () => {
  const wrap = document.createElement("div");
  wrap.className = "stack";
  if (state.event.pilots.length === 0) {
    wrap.append(text("p", "Pilots appear here after they are added on the race desk."));
    return wrap;
  }
  for (const pilot of state.event.pilots) {
    const record = state.records.find((item) => item.pilotId === pilot.id);
    const block = document.createElement("section");
    block.className = "stack";
    block.append(
      text("h2", pilot.name),
      text("p", `Holeshot ${formatSeconds(record?.holeshot)} · best lap ${formatSeconds(record?.bestLap)} · full race ${formatSeconds(record?.race)}`),
    );
    const rows = [];
    for (const round of state.event.rounds) {
      for (const race of round.races) {
        const slot = race.slots.find((item) => item.pilotId === pilot.id);
        if (slot == null) continue;
        rows.push([
          `${round.eventType} ${round.number}-${race.number}`,
          slot.position == null ? "" : String(slot.position),
          String(scoring(slot).length),
          slot.crashed ? "Crashed" : slot.dnf ? "DNF" : "",
        ]);
      }
    }
    block.append(table(["Heat", "Place", "Laps", "Status"], rows));
    wrap.append(block);
  }
  return wrap;
};

const refresh = async () => {
  const response = await fetch("/api/state");
  const next = await response.json();
  if (state != null && next.event.updatedAt === state.event.updatedAt && next.event.theme === state.event.theme) return;
  state = next;
  render();
};

refresh();
setInterval(refresh, 1000);

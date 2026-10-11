import { chargedSeconds, formatSeconds } from "./clock.js";

/** Every gate call in a heat, on the heat clock (pauses removed). */
export const replayEvents = (race) => {
  if (race.startedAt == null) return [];
  const start = Date.parse(race.startedAt);
  const clock = (iso) => chargedSeconds(race, start, Date.parse(iso));
  const events = [];
  for (const slot of race.slots) {
    for (const lap of slot.laps) {
      events.push({
        kind: lap.number === 0 ? "holeshot" : "lap",
        pilotId: slot.pilotId,
        number: lap.number,
        lengthSeconds: lap.lengthSeconds,
        t: clock(lap.endedAt),
      });
    }
    (slot.gamePoints ?? []).forEach((point, index) => {
      events.push({ kind: "point", pilotId: slot.pilotId, number: index + 1, t: clock(point.at) });
    });
  }
  events.sort((left, right) => left.t - right.t);
  if (race.endedAt != null) {
    const end = clock(race.endedAt);
    events.push({ kind: "end", t: Math.max(end, events.at(-1)?.t ?? 0) });
  }
  return events;
};

/** Seat order at heat time t: most laps (or game points) first, then whoever got there first. */
export const standingsAt = (race, events, t) => {
  const rows = race.slots.map((slot) => ({
    pilotId: slot.pilotId,
    channelId: slot.channelId,
    laps: 0,
    points: 0,
    holeshot: null,
    lastLap: null,
    reachedAt: Number.POSITIVE_INFINITY,
  }));
  const byPilot = new Map(rows.map((row) => [row.pilotId, row]));
  for (const event of events) {
    if (event.t > t || event.pilotId == null) continue;
    const row = byPilot.get(event.pilotId);
    if (event.kind === "holeshot") row.holeshot = event.lengthSeconds;
    if (event.kind === "lap") {
      row.laps += 1;
      row.lastLap = event.lengthSeconds;
    }
    if (event.kind === "point") row.points += 1;
    row.reachedAt = event.t;
  }
  return rows.sort(
    (left, right) =>
      right.points - left.points || right.laps - left.laps || left.reachedAt - right.reachedAt,
  );
};

export const describeEvent = (event, nameOf) => {
  if (event == null) return "Heat start";
  if (event.kind === "end") return "Heat finished";
  const name = nameOf(event.pilotId);
  if (event.kind === "holeshot") return `${name} holeshot ${formatSeconds(event.lengthSeconds)}`;
  if (event.kind === "point") return `${name} game point ${event.number}`;
  return `${name} lap ${event.number} ${formatSeconds(event.lengthSeconds)}`;
};

/** The call at or before t, and the index of the next one. */
export const cursorAt = (events, t) => {
  let index = -1;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].t <= t + 1e-9) index = i;
  }
  return index;
};

const element = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/**
 * Open a replay dialog for one heat. `nameOf` and `channelOf` resolve ids
 * from the caller's state.
 */
export const openReplay = ({ race, title, nameOf, channelOf }) => {
  const events = replayEvents(race);
  const end = events.at(-1)?.t ?? 0;
  let t = 0;
  let speed = 1;
  let playing = false;
  let last = 0;
  let frame = null;

  const slider = element("input", { type: "range", min: "0", max: String(Math.max(end, 0.001)), step: "0.01", value: "0" });
  slider.setAttribute("aria-label", "Heat time");
  const clock = element("span", { className: "clock" });
  const caption = element("p", { className: "help" });
  const table = element("table");
  const play = element("button", { type: "button", textContent: "Play" });
  const back = element("button", { type: "button", className: "secondary", textContent: "◀ Previous call" });
  const forward = element("button", { type: "button", className: "secondary", textContent: "Next call ▶" });
  const rate = element("select", {}, [1, 2, 4, 8].map((value) => element("option", { value: String(value), textContent: `${value}×` })));
  rate.setAttribute("aria-label", "Replay speed");
  const close = element("button", { type: "button", className: "secondary", textContent: "Close" });
  const dialog = element("dialog", { className: "replay panel" }, [
    element("div", { className: "stack" }, [
      element("h2", { textContent: `Replay · ${title}` }),
      element("p", { className: "help", textContent: "Scrub the timeline or step one gate call at a time. Places are worked out from the calls made up to that moment." }),
      element("div", { className: "race-head" }, [clock, play, back, forward, rate, close]),
      slider,
      caption,
      table,
    ]),
  ]);

  const draw = () => {
    slider.value = String(t);
    clock.textContent = formatSeconds(t);
    const index = cursorAt(events, t);
    caption.textContent = `${index + 1} of ${events.length} calls · ${describeEvent(events[index], nameOf)}`;
    const rows = standingsAt(race, events, t);
    const game = rows.some((row) => row.points > 0);
    table.replaceChildren(
      element("tr", {}, ["Place", "Pilot", "Channel", game ? "Points" : "Laps", "Holeshot", "Last lap"].map((text) => element("th", { textContent: text }))),
      ...rows.map((row, place) =>
        element("tr", {}, [
          String(place + 1),
          nameOf(row.pilotId),
          channelOf(row.channelId)?.name ?? "",
          String(game ? row.points : row.laps),
          formatSeconds(row.holeshot),
          formatSeconds(row.lastLap),
        ].map((text) => element("td", { textContent: text })))),
    );
    play.textContent = playing ? "Pause" : t >= end ? "Play again" : "Play";
  };

  const stop = () => {
    playing = false;
    if (frame != null) cancelAnimationFrame(frame);
    frame = null;
  };

  const tick = (now) => {
    t = Math.min(end, t + ((now - last) / 1000) * speed);
    last = now;
    if (t >= end) stop();
    draw();
    if (playing) frame = requestAnimationFrame(tick);
  };

  play.addEventListener("click", () => {
    if (playing) {
      stop();
      draw();
      return;
    }
    if (t >= end) t = 0;
    playing = true;
    last = performance.now();
    frame = requestAnimationFrame(tick);
  });
  back.addEventListener("click", () => {
    stop();
    const index = cursorAt(events, t);
    t = index <= 0 ? 0 : events[index - 1].t;
    draw();
  });
  forward.addEventListener("click", () => {
    stop();
    const next = events.find((event) => event.t > t + 1e-9);
    t = next?.t ?? end;
    draw();
  });
  slider.addEventListener("input", () => {
    stop();
    t = Number(slider.value);
    draw();
  });
  rate.addEventListener("change", () => {
    speed = Number(rate.value);
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    stop();
    dialog.remove();
  });
  document.body.append(dialog);
  draw();
  dialog.showModal();
  return dialog;
};

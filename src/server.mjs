import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { CHANNEL_CATALOG } from "./channels.mjs";
import { applyCamera } from "./camera-api.mjs";
import { FORMATS, buildRound, formatBoard, generateRound } from "./formats.mjs";
import { listScripts, runScriptRound, runScriptStandings } from "./lua-host.mjs";
import { validTrack } from "../public/track.js";
import {
  CHANNEL_PACKS,
  EVENT_MODES,
  channelsForPack,
  createEvent,
  deskStep,
  eventChannel,
  findRace,
  paintChannels,
  pilotById,
} from "./model.mjs";
import { parsePositionPoints, pointsSettings, scoreRace, stageStandings } from "./points.mjs";
import { loadEvent, saveEvent } from "./store.mjs";
import {
  TIMING_DEFAULTS,
  captionLines,
  emergencyStop,
  finishRace,
  lapCounts,
  lapRecords,
  markCrashed,
  markDnf,
  pauseRace,
  raceCursor,
  raceRules,
  recordLap,
  restartRace,
  resumeRace,
  startRace,
  tickRace,
  undoLap,
} from "./timing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".wav", "audio/wav"],
]);

const readJson = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const scriptFormats = (scripts) =>
  scripts.map(({ id, name, description, author, error, file }) => ({ id, name, description, author, error, file, script: true }));

const boardFor = (event, scripts) => {
  const latest = event.rounds.at(-1);
  const script = latest?.format?.startsWith("script:") ? scripts.find((item) => item.id === latest.format) : null;
  if (script != null) return runScriptStandings(event, script, latest.stageId);
  return formatBoard(event);
};

const snapshot = (event, scripts = []) => {
  const cursor = raceCursor(event);
  const describe = (entry) => {
    if (entry == null) return null;
    return {
      roundId: entry.round.id,
      roundNumber: entry.round.number,
      roundName: entry.round.name,
      raceId: entry.race.id,
      raceNumber: entry.race.number,
      bracket: entry.race.bracket,
      ended: entry.race.endedAt != null,
      started: entry.race.startedAt != null,
    };
  };
  return {
    event,
    formats: [...FORMATS, ...scriptFormats(scripts)],
    modes: EVENT_MODES,
    packs: CHANNEL_PACKS.map(({ id, title, detail }) => ({ id, title, detail })),
    catalog: CHANNEL_CATALOG,
    rules: raceRules(event, null),
    step: deskStep(event),
    records: lapRecords(event),
    lapCounts: lapCounts(event),
    standings: stageStandings(event),
    board: boardFor(event, scripts),
    captions: captionLines(event),
    cursor: {
      previous: describe(cursor.previous),
      current: describe(cursor.current),
      next: describe(cursor.next),
    },
  };
};

const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,60}\.lua$/;

const apply = (event, method, pathname, body, context = {}) => {
  const camera = applyCamera(event, method, pathname, body);
  if (camera != null) return camera;

  if (method === "PUT" && pathname === "/api/track") {
    const track = validTrack(body.track);
    if (track == null) return { error: "The track needs a list of pieces." };
    event.track = track;
    return { ok: true };
  }

  if (method === "POST" && pathname === "/api/scripts") {
    const file = typeof body.file === "string" ? body.file.trim() : "";
    const source = typeof body.source === "string" ? body.source : "";
    if (!SCRIPT_NAME.test(file) || file.includes("..")) {
      return { error: "Name the script like my_format.lua, using letters, numbers, spaces, dashes or underscores." };
    }
    if (source.trim() === "" || source.length > 200_000) return { error: "The script must hold some Lua and stay under 200 KB." };
    mkdirSync(context.scriptsDir, { recursive: true });
    writeFileSync(path.join(context.scriptsDir, file), source);
    const script = listScripts(context.scriptsDir).find((item) => item.file === file);
    if (script?.error != null) return { ok: true, note: `${file} was saved, but it cannot draw rounds yet: ${script.error}` };
    return { ok: true, note: `${script?.name ?? file} is now in the format list.` };
  }

  if (method === "PATCH" && pathname === "/api/event") {
    if (typeof body.name === "string" && body.name.trim() !== "") {
      event.name = body.name.trim().slice(0, 80);
    }
    if (body.laps != null) event.laps = clampInteger(body.laps, 1, 20);
    if (body.pbLaps != null) event.pbLaps = clampInteger(body.pbLaps, 1, 20);
    if (body.maxPilotsPerRace != null) {
      event.maxPilotsPerRace = clampInteger(body.maxPilotsPerRace, 1, 8);
    }
    if (body.raceLengthSeconds != null) {
      event.raceLengthSeconds = clampInteger(body.raceLengthSeconds, 30, 3600);
    }
    if (typeof body.mode === "string" && EVENT_MODES.some((mode) => mode.id === body.mode)) {
      event.mode = body.mode;
    }
    if (
      typeof body.theme === "string" &&
      ["night", "light", "contrast", "synth", "clear", "space"].includes(body.theme)
    ) {
      event.theme = body.theme;
    }
    if (typeof body.sound === "boolean") event.sound = body.sound;
    if (typeof body.holeshot === "boolean") event.holeshot = body.holeshot;
    if (typeof body.captions === "boolean") event.captions = body.captions;
    if (body.minLapSeconds != null) event.minLapSeconds = clampNumber(body.minLapSeconds, 0, 120);
    if (body.startIgnoreSeconds != null) event.startIgnoreSeconds = clampNumber(body.startIgnoreSeconds, 0, 30);
    if (body.startDelayMinSeconds != null) event.startDelayMinSeconds = clampNumber(body.startDelayMinSeconds, 0, 30);
    if (body.startDelayMaxSeconds != null) event.startDelayMaxSeconds = clampNumber(body.startDelayMaxSeconds, 0, 30);
    if ((event.startDelayMaxSeconds ?? TIMING_DEFAULTS.startDelayMaxSeconds) < (event.startDelayMinSeconds ?? TIMING_DEFAULTS.startDelayMinSeconds)) {
      event.startDelayMaxSeconds = event.startDelayMinSeconds;
    }
    const before = JSON.stringify(pointsSettings(event));
    if (body.positionPoints != null) {
      const table = parsePositionPoints(body.positionPoints);
      if (table == null) return { error: "Points by place must be whole numbers from 0 to 1000, separated by commas." };
      event.points = { ...pointsSettings(event), positionPoints: table };
    }
    if (body.dnfPoints != null) event.points = { ...pointsSettings(event), dnfPoints: clampInteger(body.dnfPoints, 0, 1000) };
    if (typeof body.dnfForUnfinishedRaces === "boolean") {
      event.points = { ...pointsSettings(event), dnfForUnfinishedRaces: body.dnfForUnfinishedRaces };
    }
    if (JSON.stringify(pointsSettings(event)) !== before) rescoreEndedRaces(event);
    return { ok: true };
  }

  if (method === "POST" && pathname === "/api/channels") {
    if (event.rounds.length > 0) {
      return { error: "Channel sets replace every channel, so they only apply before the first round. Toggle single channels instead." };
    }
    const channels = channelsForPack(body.pack);
    if (channels == null) return { error: "Unknown channel set." };
    event.channels = channels;
    return { ok: true };
  }

  if (method === "POST" && pathname === "/api/channels/toggle") {
    const channel = eventChannel(body.catalogId);
    if (channel == null) return { error: "Unknown channel." };
    const present = event.channels.some((existing) => existing.catalogId === channel.catalogId);
    if (body.on === true && !present) {
      event.channels = paintChannels([...event.channels, channel]);
      return { ok: true };
    }
    if (body.on === false && present) {
      const existing = event.channels.find((item) => item.catalogId === channel.catalogId);
      const used = event.rounds.some((round) =>
        round.races.some((race) => race.slots.some((slot) => slot.channelId === existing.id)),
      );
      if (used) return { error: `${existing.name} is already used in a heat, so it stays in the event.` };
      if (event.channels.length <= 1) return { error: "Keep at least one channel." };
      event.channels = paintChannels(event.channels.filter((item) => item.catalogId !== channel.catalogId));
      return { ok: true };
    }
    return { ok: true };
  }

  const stageMatch = pathname.match(/^\/api\/stages\/([^/]+)$/);
  if (method === "PATCH" && stageMatch != null) {
    const stage = event.stages.find((item) => item.id === decodeURIComponent(stageMatch[1]));
    if (stage == null) return { error: "Stage not found.", status: 404 };
    if (typeof body.name === "string" && body.name.trim() !== "") stage.name = body.name.trim().slice(0, 40);
    if (body.active === true) event.activeStageId = stage.id;
    if (body.pointSummary === null) delete stage.pointSummary;
    else if (body.pointSummary != null) {
      const current = stage.pointSummary ?? { dropWorstRound: true, roundPositionRollover: false };
      stage.pointSummary = {
        dropWorstRound: typeof body.pointSummary.dropWorstRound === "boolean" ? body.pointSummary.dropWorstRound : current.dropWorstRound,
        roundPositionRollover: typeof body.pointSummary.roundPositionRollover === "boolean"
          ? body.pointSummary.roundPositionRollover
          : current.roundPositionRollover,
      };
    }
    return { ok: true };
  }

  if (method === "POST" && pathname === "/api/sample") {
    if (event.rounds.length > 0) {
      return { error: "Reset the event before loading a practice field." };
    }
    const names = ["Ada", "Bo", "Cy", "Dee", "Eli", "Faye", "Gus", "Hana"];
    event.pilots = names.map((name) => ({ id: crypto.randomUUID(), name }));
    event.name = event.name === "Club race" ? "Practice night" : event.name;
    return { ok: true };
  }

  if (method === "POST" && pathname === "/api/pilots/paste") {
    const names = String(body.text ?? "")
      .split(/\r?\n|,/)
      .map((name) => name.trim())
      .filter((name) => name !== "");
    if (names.length === 0) return { error: "Paste one pilot name per line." };
    let added = 0;
    for (const name of names) {
      const exists = event.pilots.some(
        (pilot) => pilot.name.toLowerCase() === name.toLowerCase(),
      );
      if (exists) continue;
      event.pilots.push({ id: crypto.randomUUID(), name: name.slice(0, 40) });
      added += 1;
    }
    return {
      ok: true,
      note: added === 0 ? "Those pilots are already on the list." : `Added ${added} pilots.`,
    };
  }

  if (method === "POST" && pathname === "/api/stages") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
    if (name === "") return { error: "Stage name is required." };
    const stage = {
      id: crypto.randomUUID(),
      name,
      order: event.stages.length + 1,
    };
    event.stages.push(stage);
    event.activeStageId = stage.id;
    return { ok: true, note: `${name} will hold the next rounds you generate.` };
  }

  if (method === "POST" && pathname === "/api/pilots") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "") return { error: "Pilot name is required." };
    event.pilots.push({ id: crypto.randomUUID(), name: name.slice(0, 40) });
    return { ok: true };
  }

  const pilotMatch = pathname.match(/^\/api\/pilots\/([^/]+)$/);
  if (method === "DELETE" && pilotMatch != null) {
    const pilotId = decodeURIComponent(pilotMatch[1]);
    const raced = event.rounds.some((round) =>
      round.races.some((race) =>
        race.slots.some((slot) => slot.pilotId === pilotId),
      ),
    );
    if (raced) return { error: "That pilot is already in a round." };
    event.pilots = event.pilots.filter((pilot) => pilot.id !== pilotId);
    return { ok: true };
  }

  if (method === "POST" && pathname === "/api/rounds") {
    if (typeof body.format === "string" && body.format.startsWith("script:")) {
      const script = listScripts(context.scriptsDir).find((item) => item.id === body.format);
      if (script == null) return { error: "That script is no longer in the scripts folder." };
      const open = event.rounds.at(-1)?.races.some((race) => race.endedAt == null);
      if (open) return { error: "Finish every heat in the current round before generating another." };
      if (event.pilots.length === 0) return { error: "Add at least one pilot." };
      const plan = runScriptRound(event, script);
      if (plan.error != null || plan.stop != null) return plan;
      const built = buildRound(event, { id: script.id, name: script.name }, plan);
      return { ...built, note: built.note ?? plan.note ?? null };
    }
    return generateRound(event, body.format);
  }

  if (method === "DELETE" && pathname === "/api/rounds/latest") {
    const latest = event.rounds.at(-1);
    if (latest == null) return { error: "There is no round to remove." };
    if (latest.races.some((race) => race.startedAt != null)) {
      return { error: "A heat in this round has already started." };
    }
    event.rounds.pop();
    return { ok: true };
  }

  const raceMatch = pathname.match(
    /^\/api\/races\/([^/]+)\/(start|lap|dnf|crash|undo|finish|pause|resume|tick|emergency|restart)$/,
  );
  if (raceMatch == null) return { error: "Unknown request.", status: 404 };
  const located = findRace(event, decodeURIComponent(raceMatch[1]));
  if (located == null) return { error: "Race not found.", status: 404 };
  const action = raceMatch[2];
  const rules = raceRules(event, located.round);
  const now = new Date();
  if (action === "start") return startRace(located.race, now, rules);
  if (action === "pause") return pauseRace(located.race, now);
  if (action === "resume") return resumeRace(located.race, now);
  if (action === "tick") return tickRace(located.race, rules, now);
  if (action === "finish") return finishRace(located.race, now, rules);
  if (action === "emergency") return emergencyStop(located.race, now, rules);
  if (action === "restart") return restartRace(located.race);
  const pilotId = body.pilotId;
  if (pilotById(event, pilotId) == null) return { error: "Pilot not found." };
  if (action === "lap") {
    const at = gateTime(body.at, located.race, now);
    if (at.error != null) return at;
    return recordLap(located.race, pilotId, at.time, rules);
  }
  if (action === "dnf") return markDnf(located.race, pilotId, now, rules);
  if (action === "crash") return markCrashed(located.race, pilotId, now, rules);
  return undoLap(located.race, pilotId);
};

/** A detector can report when it saw the gate. Times must fall inside the heat and not in the future. */
const gateTime = (value, race, now) => {
  if (value == null) return { time: now };
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return { error: "The gate time must be an ISO date." };
  if (time.getTime() > now.getTime() + 2000) return { error: "The gate time is in the future." };
  if (race.startedAt != null && time.getTime() < Date.parse(race.startedAt)) {
    return { error: "The gate time is before the start horn.", ignored: true };
  }
  return { time };
};

const rescoreEndedRaces = (event) => {
  for (const round of event.rounds) {
    const { eventType, points } = raceRules(event, round);
    for (const race of round.races) {
      if (race.endedAt != null) scoreRace(race, eventType, points);
    }
  }
};

const clampInteger = (value, min, max) => {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
};

const clampNumber = (value, min, max) => {
  const number = Math.round(Number(value) * 10) / 10;
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
};

const sendJson = (response, status, body) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
};

export const createApp = (dataFile, { scriptsDir = path.join(root, "scripts") } = {}) =>
  createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const event = loadEvent(dataFile);
        const view = (current) => snapshot(current, listScripts(scriptsDir));
        if (request.method === "GET" && url.pathname === "/api/state") {
          sendJson(response, 200, view(event));
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/reset") {
          saveEvent(dataFile, createEvent());
          sendJson(response, 200, view(loadEvent(dataFile)));
          return;
        }
        const result = apply(
          event,
          request.method ?? "GET",
          url.pathname,
          request.method === "DELETE" ? {} : await readJson(request),
          { scriptsDir },
        );
        if (result.error != null && result.round == null && result.stop == null && result.ok == null) {
          sendJson(response, result.status ?? 400, { error: result.error, ignored: result.ignored === true });
          return;
        }
        if (result.ok === true || result.round != null) saveEvent(dataFile, event);
        sendJson(response, 200, { ...result, ...view(loadEvent(dataFile)) });
        return;
      }

      const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.resolve(publicDir, relative);
      const fromPublic = path.relative(publicDir, file);
      if (fromPublic.startsWith("..") || path.isAbsolute(fromPublic)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file).catch((error) => {
        if (error?.code === "ENOENT" || error?.code === "EISDIR") return null;
        throw error;
      });
      if (body == null) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type":
          contentTypes.get(path.extname(file)) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Request failed.",
      });
    }
  });

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  const dataFile = path.join(root, "data", "event.json");
  const server = createApp(dataFile);
  server.listen(port, "127.0.0.1", () => {
    console.log(`WebFPV Club Timer at http://127.0.0.1:${port}`);
  });
}

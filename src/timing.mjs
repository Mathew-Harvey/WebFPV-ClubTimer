import { holeshotLap, scoringLaps } from "./model.mjs";
import {
  DEFAULT_POINTS,
  clearScore,
  endsOnClock,
  hasDelayedStart,
  hasLapLimit,
  pointsSettings,
  scoreRace,
  usesTimingSystem,
} from "./points.mjs";

const sumLengths = (laps) =>
  laps.reduce((total, lap) => total + lap.lengthSeconds, 0);

/** RaceLib.Event defaults: 5 s minimum lap, 0.5 s start window, 0.5 to 5 s random start hold. */
export const TIMING_DEFAULTS = Object.freeze({
  minLapSeconds: 5,
  startIgnoreSeconds: 0.5,
  startDelayMinSeconds: 0.5,
  startDelayMaxSeconds: 5,
  raceLengthSeconds: 120,
});

export const raceRules = (event, round) => ({
  eventType: round?.eventType ?? event.mode ?? "Race",
  points: pointsSettings(event),
  minLapSeconds: event.minLapSeconds ?? TIMING_DEFAULTS.minLapSeconds,
  startIgnoreSeconds: event.startIgnoreSeconds ?? TIMING_DEFAULTS.startIgnoreSeconds,
  startDelayMinSeconds: event.startDelayMinSeconds ?? TIMING_DEFAULTS.startDelayMinSeconds,
  startDelayMaxSeconds: event.startDelayMaxSeconds ?? TIMING_DEFAULTS.startDelayMaxSeconds,
});

const DEFAULT_RULES = Object.freeze({
  eventType: "Race",
  points: DEFAULT_POINTS,
  ...TIMING_DEFAULTS,
});

const rulesOf = (rules) => (typeof rules === "string" ? { ...DEFAULT_RULES, eventType: rules } : { ...DEFAULT_RULES, ...rules });

const isOut = (slot) => slot.dnf === true || slot.crashed === true;

export const chargedSeconds = (race, fromMs, toMs) => {
  let cut = 0;
  for (const pause of race.pauses ?? []) {
    const start = Date.parse(pause.start);
    const end = pause.end == null ? toMs : Date.parse(pause.end);
    const left = Math.max(fromMs, start);
    const right = Math.min(toMs, end);
    if (right > left) cut += right - left;
  }
  return Math.round(Math.max(0, toMs - fromMs - cut)) / 1000;
};

export const clockSeconds = (race, now = new Date()) => {
  if (race.startedAt == null) return 0;
  const start = Date.parse(race.startedAt);
  const to = race.endedAt == null ? now.getTime() : Date.parse(race.endedAt);
  return chargedSeconds(race, start, Math.max(start, to));
};

/** The clock runs from a random hold after Start, so pilots cannot anticipate the horn. */
export const startRace = (race, now = new Date(), rules = DEFAULT_RULES, random = Math.random) => {
  const { eventType, startDelayMinSeconds, startDelayMaxSeconds } = rulesOf(rules);
  if (race.startedAt != null) return { error: "Race has already started." };
  if (race.endedAt != null) return { error: "Race has already ended." };
  const low = Math.max(0, Math.min(startDelayMinSeconds, startDelayMaxSeconds));
  const high = Math.max(low, startDelayMaxSeconds);
  const holdSeconds = hasDelayedStart(eventType) ? Math.round((low + random() * (high - low)) * 1000) / 1000 : 0;
  race.armedAt = now.toISOString();
  race.startedAt = new Date(now.getTime() + holdSeconds * 1000).toISOString();
  race.startHoldSeconds = holdSeconds;
  return { ok: true };
};

const clearResult = (race) => {
  race.endedAt = null;
  for (const slot of race.slots) clearScore(slot);
};

export const finishRace = (race, now = new Date(), rules = DEFAULT_RULES) => {
  const { eventType, points } = rulesOf(rules);
  if (race.startedAt == null) return { error: "Race has not started." };
  if (race.endedAt != null) return { error: "Race has already ended." };
  if (race.pausedAt != null) resumeRace(race, now);
  const start = Date.parse(race.startedAt);
  race.endedAt = new Date(Math.max(start, now.getTime())).toISOString();
  scoreRace(race, eventType, points);
  return { ok: true };
};

const maybeFinish = (race, now, rules) => {
  const { eventType } = rules;
  if (endsOnClock(eventType)) {
    if (clockSeconds(race, now) >= (race.raceLengthSeconds ?? TIMING_DEFAULTS.raceLengthSeconds)) {
      finishRace(race, now, rules);
    }
    return;
  }
  if (!hasLapLimit(eventType)) return;
  const complete = race.slots.every(
    (slot) => isOut(slot) || scoringLaps(slot).length >= race.targetLaps,
  );
  if (complete) finishRace(race, now, rules);
};

const requireOpen = (race, now) => {
  if (race.startedAt == null) return "Race has not started.";
  if (race.endedAt != null) return "Race has ended.";
  if (race.pausedAt != null) return "The clock is paused.";
  if (now.getTime() < Date.parse(race.startedAt)) return "The start horn has not sounded yet.";
  return null;
};

export const recordLap = (race, pilotId, now = new Date(), rules = DEFAULT_RULES) => {
  const resolved = rulesOf(rules);
  const { eventType, minLapSeconds, startIgnoreSeconds } = resolved;
  const blocked = requireOpen(race, now);
  if (blocked != null) return { error: blocked };
  const slot = race.slots.find((candidate) => candidate.pilotId === pilotId);
  if (slot == null) return { error: "That pilot is not in this race." };
  if (slot.dnf) return { error: "That pilot is marked DNF." };
  if (slot.crashed) return { error: "That pilot is marked crashed." };
  if (eventType === "Game") {
    slot.gamePoints ??= [];
    slot.gamePoints.push({ at: now.toISOString() });
    return { ok: true };
  }
  if (!usesTimingSystem(eventType)) return { error: "Freestyle has no gate timing. Close the session when the pack lands." };
  if (hasLapLimit(eventType) && scoringLaps(slot).length >= race.targetLaps) {
    return { error: "That pilot has already finished the target laps." };
  }
  const previous = slot.laps.at(-1);
  const from = Date.parse(previous?.endedAt ?? race.startedAt);
  const lengthSeconds = chargedSeconds(race, from, now.getTime());
  if (previous == null && lengthSeconds < startIgnoreSeconds) {
    return { error: `Ignored: the gate is closed for ${startIgnoreSeconds} s after the start.`, ignored: true };
  }
  if (lengthSeconds <= 0) return { error: "Lap time must be greater than zero." };
  const holeshot = race.holeshot !== false;
  const number = holeshot ? slot.laps.length : slot.laps.length + 1;
  if (number > 0 && lengthSeconds < minLapSeconds) {
    return { error: `Ignored: ${lengthSeconds.toFixed(3)} s is under the ${minLapSeconds} s minimum lap.`, ignored: true };
  }
  slot.laps.push({ number, lengthSeconds, endedAt: now.toISOString() });
  maybeFinish(race, now, resolved);
  return { ok: true };
};

export const markDnf = (race, pilotId, now = new Date(), rules = DEFAULT_RULES) => {
  const blocked = requireOpen(race, now);
  if (blocked != null) return { error: blocked };
  const slot = race.slots.find((candidate) => candidate.pilotId === pilotId);
  if (slot == null) return { error: "That pilot is not in this race." };
  slot.dnf = true;
  slot.crashed = false;
  maybeFinish(race, now, rulesOf(rules));
  return { ok: true };
};

export const markCrashed = (race, pilotId, now = new Date(), rules = DEFAULT_RULES) => {
  const blocked = requireOpen(race, now);
  if (blocked != null) return { error: blocked };
  const slot = race.slots.find((candidate) => candidate.pilotId === pilotId);
  if (slot == null) return { error: "That pilot is not in this race." };
  slot.crashed = true;
  slot.dnf = false;
  maybeFinish(race, now, rulesOf(rules));
  return { ok: true };
};

export const pauseRace = (race, now = new Date()) => {
  if (race.startedAt == null) return { error: "Race has not started." };
  if (race.endedAt != null) return { error: "Race has already ended." };
  if (race.pausedAt != null) return { error: "The clock is already paused." };
  if (now.getTime() < Date.parse(race.startedAt)) return { error: "The start horn has not sounded yet." };
  race.pauses ??= [];
  race.pauses.push({ start: now.toISOString(), end: null });
  race.pausedAt = now.toISOString();
  return { ok: true };
};

export const resumeRace = (race, now = new Date()) => {
  if (race.pausedAt == null) return { error: "The clock is not paused." };
  const open = (race.pauses ?? []).find((pause) => pause.end == null);
  if (open != null) open.end = now.toISOString();
  race.pausedAt = null;
  return { ok: true };
};

export const emergencyStop = (race, now = new Date(), rules = DEFAULT_RULES) => {
  const resolved = rulesOf(rules);
  if (race.startedAt == null) return { error: "Race has not started." };
  if (race.endedAt != null) return { error: "Race has already ended." };
  if (hasLapLimit(resolved.eventType)) {
    for (const slot of race.slots) {
      if (!slot.crashed && scoringLaps(slot).length < race.targetLaps) slot.dnf = true;
    }
  }
  race.emergency = true;
  return finishRace(race, now, resolved);
};

export const restartRace = (race) => {
  if (race.startedAt == null && race.endedAt == null) {
    return { error: "This heat has not started." };
  }
  race.startedAt = null;
  race.armedAt = null;
  race.startHoldSeconds = null;
  race.endedAt = null;
  race.pausedAt = null;
  race.pauses = [];
  race.emergency = false;
  for (const slot of race.slots) {
    slot.laps = [];
    slot.gamePoints = [];
    slot.dnf = false;
    slot.crashed = false;
    clearScore(slot);
  }
  return { ok: true };
};

export const tickRace = (race, rules = DEFAULT_RULES, now = new Date()) => {
  if (race.startedAt == null || race.endedAt != null || race.pausedAt != null) {
    return { ok: true };
  }
  maybeFinish(race, now, rulesOf(rules));
  return { ok: true };
};

export const undoLap = (race, pilotId) => {
  const slot = race.slots.find((candidate) => candidate.pilotId === pilotId);
  if (slot == null) return { error: "That pilot is not in this race." };
  if (slot.dnf || slot.crashed) {
    slot.dnf = false;
    slot.crashed = false;
  } else if ((slot.gamePoints?.length ?? 0) > 0) {
    slot.gamePoints.pop();
  } else if (slot.laps.length > 0) {
    slot.laps.pop();
  } else {
    return { error: "That pilot has no laps to undo." };
  }
  if (race.endedAt != null) clearResult(race);
  return { ok: true };
};

export const captionLines = (event) => {
  const lines = [];
  const nameOf = (pilotId) =>
    event.pilots.find((pilot) => pilot.id === pilotId)?.name ?? "Pilot";
  for (const round of event.rounds) {
    for (const race of round.races) {
      const label = `${round.eventType} ${round.number}-${race.number}`;
      if (race.armedAt != null && race.startHoldSeconds > 0) {
        lines.push({ at: race.armedAt, text: `${label} armed, horn after a ${race.startHoldSeconds.toFixed(1)} s hold` });
      }
      if (race.startedAt != null) lines.push({ at: race.startedAt, text: `${label} started` });
      for (const slot of race.slots) {
        const name = nameOf(slot.pilotId);
        for (const lap of slot.laps) {
          const kind = lap.number === 0 ? "holeshot" : `lap ${lap.number}`;
          lines.push({
            at: lap.endedAt,
            text: `${name} ${kind} ${lap.lengthSeconds.toFixed(3)}s`,
          });
        }
        (slot.gamePoints ?? []).forEach((point, index) => {
          lines.push({ at: point.at, text: `${name} game point ${index + 1}` });
        });
      }
      if (race.emergency) lines.push({ at: race.endedAt, text: `${label} emergency stop` });
      else if (race.endedAt != null) lines.push({ at: race.endedAt, text: `${label} finished` });
    }
  }
  return lines
    .filter((line) => line.at != null)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
};

const slotInRace = (race, pilotId) =>
  race.slots.find((slot) => slot.pilotId === pilotId) ?? null;

const bestWindow = (laps, count) => {
  if (count <= 0 || laps.length < count) return null;
  const ordered = [...laps].sort((left, right) => left.number - right.number);
  let best = null;
  for (let index = 0; index <= ordered.length - count; index += 1) {
    const window = ordered.slice(index, index + count);
    const time = sumLengths(window);
    if (best == null || time < best.time) best = { laps: window, time };
  }
  return best;
};

export const lapRecords = (event) =>
  event.pilots.map((pilot) => {
    const record = {
      pilotId: pilot.id,
      name: pilot.name,
      holeshot: null,
      bestLap: null,
      pb: null,
      target: null,
      race: null,
    };
    for (const round of event.rounds) {
      for (const race of round.races) {
        const slot = slotInRace(race, pilot.id);
        if (slot == null) continue;
        const hole = holeshotLap(slot);
        if (hole != null && (record.holeshot == null || hole.lengthSeconds < record.holeshot)) {
          record.holeshot = hole.lengthSeconds;
        }
        const scoring = scoringLaps(slot);
        for (const lap of scoring) {
          if (record.bestLap == null || lap.lengthSeconds < record.bestLap) {
            record.bestLap = lap.lengthSeconds;
          }
        }
        const pb = bestWindow(scoring, event.pbLaps);
        if (pb != null && (record.pb == null || pb.time < record.pb)) record.pb = pb.time;
        const target = bestWindow(scoring, event.laps);
        if (target != null && (record.target == null || target.time < record.target)) {
          record.target = target.time;
        }
        const fullCount = race.holeshot === false ? race.targetLaps : race.targetLaps + 1;
        if (slot.laps.length === fullCount) {
          const raceTime = sumLengths(slot.laps);
          if (record.race == null || raceTime < record.race) record.race = raceTime;
        }
      }
    }
    return record;
  });

export const lapCounts = (event) =>
  event.pilots.map((pilot) => {
    const row = { pilotId: pilot.id, name: pilot.name, total: 0, rounds: {} };
    for (const round of event.rounds) {
      let count = 0;
      for (const race of round.races) {
        const slot = slotInRace(race, pilot.id);
        if (slot != null) count += scoringLaps(slot).length;
      }
      row.rounds[round.id] = count;
      row.total += count;
    }
    return row;
  });

export const raceCursor = (event) => {
  const races = event.rounds.flatMap((round) =>
    round.races.map((race) => ({ round, race })),
  );
  let previous = null;
  let current = null;
  for (let index = 0; index < races.length; index += 1) {
    const entry = races[index];
    if (entry.race.endedAt == null) {
      return {
        previous: current,
        current: entry,
        next: races[index + 1] ?? null,
      };
    }
    previous = current;
    current = entry;
  }
  return { previous, current, next: null };
};

export const bestConsecutiveSeconds = (event, pilotId, count) => {
  let best = 0;
  for (const round of event.rounds) {
    for (const race of round.races) {
      if (race.endedAt == null) continue;
      const slot = slotInRace(race, pilotId);
      if (slot == null) continue;
      const window = bestWindow(scoringLaps(slot), count);
      if (window != null && (best === 0 || window.time < best)) best = window.time;
    }
  }
  return best;
};

export const resultsFor = (event, pilotId) => {
  const results = [];
  for (const round of event.rounds) {
    for (const race of round.races) {
      if (race.endedAt == null) continue;
      const slot = slotInRace(race, pilotId);
      if (slot == null || slot.position == null) continue;
      results.push({
        points: slot.points ?? 0,
        position: slot.position,
        laps: scoringLaps(slot).length,
        dnf: slot.dnf === true || slot.resultDnf === true,
        round: round.number,
        time: sumLengths(slot.laps),
        bracket: race.bracket,
      });
    }
  }
  return results;
};

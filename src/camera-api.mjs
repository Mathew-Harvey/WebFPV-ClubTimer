import { findRace, scoringLaps } from "./model.mjs";
import { hasLapLimit } from "./points.mjs";
import { markCrashed, raceRules, recordLap } from "./timing.mjs";

/** The camera page and the desk share a clock; this only absorbs request latency and jitter. */
const FUTURE_TOLERANCE_MS = 5000;

const timeOf = (value) => {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
};

const raceOpen = (race, now) =>
  race.startedAt != null &&
  race.endedAt == null &&
  race.pausedAt == null &&
  now.getTime() >= Date.parse(race.startedAt);

/**
 * Camera timing requests, keyed by the channel the camera watches:
 *   POST /api/races/:id/detect     { channelId, at, peak? }  lap that ended at `at` (epoch ms or ISO)
 *   POST /api/races/:id/autocrash  { channelId, crashed }    video static detector verdict
 * Returns null for any other request.
 */
export const applyCamera = (event, method, pathname, body, now = new Date()) => {
  const match = pathname.match(/^\/api\/races\/([^/]+)\/(detect|autocrash)$/);
  if (method !== "POST" || match == null) return null;
  const located = findRace(event, decodeURIComponent(match[1]));
  if (located == null) return { error: "Race not found.", status: 404 };
  const slot = located.race.slots.find((candidate) => candidate.channelId === body.channelId);
  if (slot == null) return { error: "No pilot is on that channel in this heat." };
  const rules = raceRules(event, located.round);

  if (match[2] === "detect") {
    const at = timeOf(body.at);
    if (at == null) return { error: "The detection time is missing." };
    if (at > now.getTime() + FUTURE_TOLERANCE_MS) return { error: "The detection time is in the future." };
    const before = slot.laps.length;
    const result = recordLap(located.race, slot.pilotId, new Date(at), rules);
    if (result.ok === true && slot.laps.length > before) {
      const lap = slot.laps.at(-1);
      lap.source = "camera";
      if (Number.isFinite(body.peak)) lap.peakPx = Math.round(body.peak);
    }
    return result;
  }

  if (body.crashed === true) {
    if (slot.crashed) return { ok: true };
    // A pilot who has landed after the finish, or is out, sends still video too.
    if (slot.dnf) return { error: "That pilot is marked DNF." };
    if (hasLapLimit(rules.eventType) && scoringLaps(slot).length >= located.race.targetLaps) {
      return { error: "That pilot has already finished the target laps." };
    }
    return markCrashed(located.race, slot.pilotId, now, rules);
  }
  if (body.crashed === false) {
    if (!raceOpen(located.race, now)) return { error: "The heat is not running." };
    if (!slot.crashed) return { ok: true };
    slot.crashed = false;
    return { ok: true };
  }
  return { error: "Send crashed as true or false." };
};

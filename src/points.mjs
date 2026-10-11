import { scoringLaps } from "./model.mjs";

/** RaceLib.PointsSettings defaults: 10, 8, 6, 4, 2, 0 by place, DNF scores 0, short pilots are DNF. */
export const DEFAULT_POINTS = Object.freeze({
  positionPoints: [10, 8, 6, 4, 2, 0],
  dnfPoints: 0,
  dnfForUnfinishedRaces: true,
});

/** RaceLib.Ext session rules, keyed by this desk's session ids. */
export const hasPoints = (eventType) => eventType === "Race" || eventType === "Endurance";
export const hasResult = (eventType) =>
  eventType === "TimeTrial" || eventType === "Race" || eventType === "Endurance";
export const hasLapLimit = (eventType) => eventType === "Race";
export const usesTimingSystem = (eventType) => eventType !== "Freestyle" && eventType !== "Game";
export const hasDelayedStart = (eventType) =>
  eventType !== "Freestyle" && eventType !== "CasualPractice";
export const endsOnClock = (eventType) => eventType === "TimeTrial" || eventType === "Endurance";

export const pointsSettings = (event) => ({
  ...DEFAULT_POINTS,
  ...(event.points ?? {}),
});

/** RaceLib.ResultManager.GetPoints: the table entry for the place, or 0 past the end. */
export const pointsForPosition = (settings, position) => {
  const index = position - 1;
  return index >= 0 && index < settings.positionPoints.length
    ? settings.positionPoints[index]
    : 0;
};

export const parsePositionPoints = (text) => {
  const parts = String(text)
    .split(/[\s,;]+/)
    .filter((part) => part !== "");
  if (parts.length === 0 || parts.length > 32) return null;
  const values = parts.map((part) => Number(part));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 1000)) return null;
  return values;
};

const sum = (laps) => laps.reduce((total, lap) => total + lap.lengthSeconds, 0);
const lastCall = (slot) => Date.parse(slot.laps.at(-1)?.endedAt ?? "") || Number.POSITIVE_INFINITY;

const trackOrder = (left, right) => {
  const laps = scoringLaps(right).length - scoringLaps(left).length;
  if (laps !== 0) return laps;
  return lastCall(left) - lastCall(right);
};

const bestRun = (slot, count) => {
  const laps = [...scoringLaps(slot)].sort((left, right) => left.number - right.number);
  if (count <= 0 || laps.length < count) return null;
  let best = null;
  for (let index = 0; index <= laps.length - count; index += 1) {
    const time = sum(laps.slice(index, index + count));
    if (best == null || time < best) best = time;
  }
  return best;
};

const timeTrialOrder = (targetLaps) => (left, right) => {
  const a = bestRun(left, targetLaps);
  const b = bestRun(right, targetLaps);
  if (a != null && b != null) return a - b;
  if (a != null) return -1;
  if (b != null) return 1;
  return trackOrder(left, right);
};

const gameOrder = (left, right) =>
  (right.gamePoints?.length ?? 0) - (left.gamePoints?.length ?? 0) ||
  lastCall(left) - lastCall(right);

export const clearScore = (slot) => {
  delete slot.position;
  delete slot.points;
  delete slot.resultDnf;
};

/** RaceLib.ResultManager.SaveResults and DNFed, applied when a heat ends. */
export const scoreRace = (race, eventType, settings) => {
  for (const slot of race.slots) clearScore(slot);
  if (eventType === "Game") {
    [...race.slots].sort(gameOrder).forEach((slot, index) => {
      slot.position = index + 1;
      slot.points = 0;
    });
    return;
  }
  if (!hasResult(eventType)) return;
  const order = eventType === "TimeTrial" ? timeTrialOrder(race.targetLaps) : trackOrder;
  [...race.slots].sort(order).forEach((slot, index) => {
    slot.position = index + 1;
    if (!hasPoints(eventType)) {
      slot.points = 0;
      return;
    }
    const short =
      hasLapLimit(eventType) &&
      settings.dnfForUnfinishedRaces &&
      race.startedAt != null &&
      scoringLaps(slot).length < race.targetLaps;
    slot.resultDnf = slot.dnf === true || short;
    slot.points = slot.resultDnf ? settings.dnfPoints : pointsForPosition(settings, slot.position);
  });
};

const competitionRank = (rows) => {
  for (const row of rows) {
    row.position = 1 + rows.filter((other) => other.total > row.total).length;
  }
  return rows.sort((left, right) => left.position - right.position || left.name.localeCompare(right.name));
};

/**
 * RaceLib.ResultManager.GetPointsTotal and GetPositionTotal per stage. A stage
 * with a points summary can drop each pilot's worst result, and can carry each
 * pilot's place from the stage before as one more scored result.
 */
export const stageStandings = (event) => {
  const settings = pointsSettings(event);
  const stages = [...(event.stages ?? [])].sort((left, right) => left.order - right.order);
  const out = [];
  let previous = null;
  for (const stage of stages) {
    const rounds = event.rounds
      .filter((round) => round.stageId === stage.id && hasPoints(round.eventType))
      .sort((left, right) => left.order - right.order);
    const summary = stage.pointSummary ?? null;
    const pilots = new Map();
    for (const round of rounds) {
      for (const race of round.races) {
        if (race.endedAt == null) continue;
        for (const slot of race.slots) {
          if (slot.points == null) continue;
          const entry = pilots.get(slot.pilotId) ?? { results: [], bracket: race.bracket };
          entry.results.push({ kind: "race", roundId: round.id, order: round.order, points: slot.points, dnf: slot.resultDnf === true });
          pilots.set(slot.pilotId, entry);
        }
      }
    }
    const rows = [];
    for (const [pilotId, entry] of pilots) {
      const results = [...entry.results];
      if (summary?.roundPositionRollover && previous != null) {
        const carried = previous.rows.find((row) => row.pilotId === pilotId);
        if (carried != null) {
          results.unshift({ kind: "rollover", position: carried.position, points: pointsForPosition(settings, carried.position) });
        }
      }
      let total = results.reduce((value, result) => value + result.points, 0);
      let dropped = null;
      if (summary?.dropWorstRound && results.length > 1) {
        const raced = results.filter((result) => result.kind === "race");
        const first = Math.min(...raced.map((result) => result.order));
        const last = Math.max(...raced.map((result) => result.order));
        const span = rounds.filter((round) => round.order >= first && round.order <= last).length;
        if (raced.length >= span) {
          dropped = results.reduce((worst, result) => (worst == null || result.points < worst.points ? result : worst), null);
          total -= dropped.points;
        }
      }
      const pilot = event.pilots.find((candidate) => candidate.id === pilotId);
      rows.push({
        pilotId,
        name: pilot?.name ?? "Pilot",
        bracket: entry.bracket ?? "None",
        total,
        rounds: Object.fromEntries(results.filter((result) => result.kind === "race").map((result) => [result.roundId, result.points])),
        rollover: results.find((result) => result.kind === "rollover") ?? null,
        dropped: dropped == null ? null : dropped.kind === "rollover" ? "rollover" : dropped.roundId,
      });
    }
    const standing = {
      stageId: stage.id,
      name: stage.name,
      summary,
      roundIds: rounds.map((round) => round.id),
      rows: competitionRank(rows),
    };
    if (rounds.length > 0) {
      out.push(standing);
      previous = standing;
    }
  }
  return out;
};

import { randomUUID } from "node:crypto";
import { assignSlots } from "./model.mjs";
import { bestConsecutiveSeconds, resultsFor } from "./timing.mjs";

export const FORMATS = [
  {
    id: "random-draw",
    name: "Random draw",
    description: "Shuffle the field and deal pilots across heats.",
  },
  {
    id: "seeded",
    name: "Seeded",
    description: "Snake the registration order across heats.",
  },
  {
    id: "points-grouped",
    name: "Points grouped",
    description: "Race similar point totals together, lowest scores first.",
  },
  {
    id: "speed-groups",
    name: "Speed groups",
    description: "Group pilots by their best run of target laps.",
  },
  {
    id: "abc-finals",
    name: "A/B/C finals",
    description: "Cut the registration order into A, B, C finals.",
  },
  {
    id: "chase-the-ace",
    name: "Chase the ace",
    description: "One heat. The first pilot to win twice takes the round.",
  },
  {
    id: "double-elimination",
    name: "Double elimination",
    description: "Winners and losers brackets. Two losses and you are out.",
  },
  {
    id: "triple-round-elimination",
    name: "Triple round elimination",
    description: "Three-round cycles. The bottom half drops, then the bottom half is out.",
  },
];

const shuffle = (items, random) => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
};

const serpentine = (ids, raceCount) => {
  const buckets = Array.from({ length: raceCount }, () => []);
  let direction = 1;
  let index = 0;
  for (const id of ids) {
    buckets[index].push(id);
    index += direction;
    if (index >= raceCount) {
      index = raceCount - 1;
      direction = -1;
    } else if (index < 0) {
      index = 0;
      direction = 1;
    }
  }
  return buckets.filter((bucket) => bucket.length > 0);
};

const deal = (ids, raceCount) => {
  const buckets = Array.from({ length: raceCount }, () => []);
  ids.forEach((id, index) => {
    buckets[index % raceCount].push(id);
  });
  return buckets.filter((bucket) => bucket.length > 0);
};

const previousRound = (event) => event.rounds.at(-1) ?? null;

const roundReady = (event) => {
  const previous = previousRound(event);
  if (previous == null) return null;
  if (previous.races.some((race) => race.endedAt == null)) {
    return "Finish every heat in the current round before generating another.";
  }
  return null;
};

const raceFor = (round, pilotId) =>
  round?.races.find((race) =>
    race.slots.some((slot) => slot.pilotId === pilotId),
  ) ?? null;

const topHalf = (round, pilotId) => {
  const race = raceFor(round, pilotId);
  if (race == null) return false;
  if (race.endedAt == null) return true;
  const slot = race.slots.find((candidate) => candidate.pilotId === pilotId);
  return slot.position <= Math.ceil(race.slots.length / 2);
};

const bracketOf = (round, pilotId) => raceFor(round, pilotId)?.bracket ?? "None";

const pointsTotal = (event, pilotId) =>
  resultsFor(event, pilotId).reduce((total, result) => total + result.points, 0);

const wins = (event, pilotId) =>
  resultsFor(event, pilotId).filter((result) => result.position === 1).length;

const byBestLap = (event, ids) =>
  [...ids].sort(
    (left, right) =>
      bestConsecutiveSeconds(event, left, 1) -
      bestConsecutiveSeconds(event, right, 1),
  );

const planHeats = (event, formatId, random) => {
  const blocked = roundReady(event);
  if (blocked != null) return { error: blocked };
  const pilots = event.pilots;
  if (pilots.length === 0) return { error: "Add at least one pilot." };
  const max = event.maxPilotsPerRace;
  const previous = previousRound(event);

  if (formatId === "random-draw") {
    const ids = shuffle(
      pilots.map((pilot) => pilot.id),
      random,
    );
    return { races: deal(ids, Math.ceil(ids.length / max)).map((pilotIds) => ({ bracket: "None", pilotIds })) };
  }

  if (formatId === "seeded") {
    const ids = pilots.map((pilot) => pilot.id);
    return {
      races: serpentine(ids, Math.ceil(ids.length / max)).map((pilotIds) => ({
        bracket: "None",
        pilotIds,
      })),
    };
  }

  if (formatId === "points-grouped") {
    const ids = [...pilots]
      .sort((left, right) => pointsTotal(event, left.id) - pointsTotal(event, right.id))
      .map((pilot) => pilot.id);
    const races = [];
    for (let index = 0; index < ids.length; index += max) {
      races.push({ bracket: "None", pilotIds: ids.slice(index, index + max) });
    }
    return { races };
  }

  if (formatId === "speed-groups") {
    const pool =
      previous == null
        ? pilots
        : pilots.filter((pilot) => resultsFor(event, pilot.id).length > 0);
    const ranked = [...pool].sort((left, right) => {
      const leftTime = bestConsecutiveSeconds(event, left.id, event.laps) || 999999;
      const rightTime = bestConsecutiveSeconds(event, right.id, event.laps) || 999999;
      return leftTime - rightTime;
    });
    if (ranked.length === 0) {
      return { stop: "Nobody has a result to group by speed yet." };
    }
    const raceCount = Math.ceil(ranked.length / max);
    const base = Math.floor(ranked.length / raceCount);
    const extra = ranked.length % raceCount;
    const races = [];
    let cursor = 0;
    for (let index = 0; index < raceCount; index += 1) {
      const size = base + (index < extra ? 1 : 0);
      races.push({
        bracket: "None",
        pilotIds: ranked.slice(cursor, cursor + size).map((pilot) => pilot.id),
      });
      cursor += size;
    }
    return { races: races.filter((race) => race.pilotIds.length > 0) };
  }

  if (formatId === "abc-finals") {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const ids = pilots.map((pilot) => pilot.id);
    const races = [];
    for (let index = 0; index < ids.length; index += max) {
      const bracketIndex = Math.floor(index / max);
      races.push({
        bracket: names[bracketIndex] ?? String(bracketIndex + 1),
        pilotIds: ids.slice(index, index + max),
      });
    }
    return { races };
  }

  if (formatId === "chase-the-ace") {
    if (previous != null) {
      const champion = pilots.find((pilot) => wins(event, pilot.id) >= 2);
      if (champion != null) {
        return { stop: `${champion.name} has two wins. Chase the ace is complete.` };
      }
    }
    const ids = pilots.slice(0, max).map((pilot) => pilot.id);
    const note =
      pilots.length > max
        ? `Chase the ace seats the first ${max} registered pilots.`
        : null;
    return { races: [{ bracket: "None", pilotIds: ids }], note };
  }

  if (formatId === "double-elimination") {
    return planDoubleElimination(event, pilots, previous, max);
  }

  if (formatId === "triple-round-elimination") {
    return planTripleRound(event, pilots, max);
  }

  return { error: "Unknown format." };
};

const planDoubleElimination = (event, pilots, previous, max) => {
  const field = previous == null ? pilots : pilots.filter((pilot) => resultsFor(event, pilot.id).length > 0);
  const winners = [];
  const losers = [];
  for (const pilot of field) {
    const bracket = bracketOf(previous, pilot.id);
    if (bracket === "None") winners.push(pilot.id);
    else if (bracket === "Winners") {
      if (topHalf(previous, pilot.id)) winners.push(pilot.id);
      else losers.push(pilot.id);
    } else if (bracket === "Losers" && topHalf(previous, pilot.id)) {
      losers.push(pilot.id);
    }
  }

  if (previous != null && previous.races.every((race) => race.endedAt != null)) {
    const active = [...winners, ...losers];
    const grand =
      winners.length <= 1 && losers.length <= 1 && (losers.length === 0 || active.length > 0);
    if (active.length > 0 && active.length <= max && (losers.length === 0 || grand)) {
      return { races: [{ bracket: "Winners", pilotIds: active }] };
    }
  }

  const winnerRaces = previous == null ? Math.ceil(pilots.length / max) : Math.ceil(winners.length / max);
  const loserRaces = previous == null ? 0 : Math.ceil(losers.length / max);
  const races = [];
  const add = (ids, raceCount, bracket) => {
    if (raceCount <= 0) return;
    for (const pilotIds of deal(byBestLap(event, ids), raceCount)) {
      races.push({ bracket, pilotIds });
    }
  };
  add(previous == null ? pilots.map((pilot) => pilot.id) : winners, winnerRaces, "Winners");
  add(losers, loserRaces, "Losers");
  if (races.length === 0) return { stop: "Nobody is left in the double elimination." };
  return { races };
};

const planTripleRound = (event, pilots, max) => {
  const stageIndex = event.rounds.length;
  const cycle = Math.floor(stageIndex / 3);
  const inCycle = stageIndex % 3;
  let winners = [];
  let losers = [];

  if (cycle === 0) {
    winners = pilots.map((pilot) => pilot.id);
  } else if (inCycle === 0) {
    const active = pilots.filter((pilot) => resultsFor(event, pilot.id).length > 0);
    const previousWinners = active.filter((pilot) => {
      const bracket = bracketOf(previousRound(event), pilot.id);
      return bracket === "Winners" || bracket === "None";
    });
    const previousLosers = active.filter(
      (pilot) => bracketOf(previousRound(event), pilot.id) === "Losers",
    );
    const cyclePoints = (pilotId) => {
      const window = event.rounds.slice(-3);
      let total = 0;
      for (const round of window) {
        for (const race of round.races) {
          if (race.endedAt == null) continue;
          const slot = race.slots.find((candidate) => candidate.pilotId === pilotId);
          if (slot != null) total += slot.points ?? 0;
        }
      }
      return total;
    };
    const byPoints = (group) =>
      [...group].sort(
        (left, right) => cyclePoints(right.id) - cyclePoints(left.id),
      );
    byPoints(previousWinners).forEach((pilot, index, group) => {
      if (index < Math.ceil(group.length / 2)) winners.push(pilot.id);
      else losers.push(pilot.id);
    });
    byPoints(previousLosers).forEach((pilot, index, group) => {
      if (index < Math.ceil(group.length / 2)) losers.push(pilot.id);
    });
  } else {
    const anchor = event.rounds[stageIndex - inCycle];
    for (const pilot of pilots) {
      if (raceFor(anchor, pilot.id) == null) continue;
      if (bracketOf(previousRound(event), pilot.id) === "Losers") losers.push(pilot.id);
      else winners.push(pilot.id);
    }
  }

  const races = [];
  const add = (ids, bracket) => {
    if (ids.length === 0) return;
    for (const pilotIds of deal(ids, Math.ceil(ids.length / max))) {
      races.push({ bracket, pilotIds });
    }
  };
  add(winners, "Winners");
  add(losers, "Losers");
  if (races.length === 0) return { stop: "Nobody is left in the triple round elimination." };
  return { races };
};

export const generateRound = (event, formatId, random = Math.random) => {
  const format = FORMATS.find((candidate) => candidate.id === formatId);
  if (format == null) return { error: "Unknown format." };
  const plan = planHeats(event, formatId, random);
  if (plan.error != null || plan.stop != null) return plan;
  return buildRound(event, format, plan);
};

/**
 * Seat a planned round: plan.races holds { bracket, pilotIds, targetLaps? },
 * plan.name and plan.eventType may override the format's defaults.
 */
export const buildRound = (event, format, plan) => {
  const races = [];
  for (let index = 0; index < plan.races.length; index += 1) {
    const planned = plan.races[index];
    const assigned = assignSlots(event, planned.pilotIds);
    if (assigned.error != null) return assigned;
    races.push({
      id: randomUUID(),
      number: index + 1,
      bracket: planned.bracket,
      targetLaps: planned.targetLaps ?? event.laps,
      valid: true,
      startedAt: null,
      endedAt: null,
      pausedAt: null,
      pauses: [],
      holeshot: event.holeshot !== false,
      raceLengthSeconds: event.raceLengthSeconds ?? 120,
      slots: assigned.slots,
    });
  }

  const round = {
    id: randomUUID(),
    order: event.rounds.length + 1,
    number: event.rounds.length + 1,
    name: plan.name ?? format.name,
    eventType: plan.eventType ?? event.mode ?? "Race",
    format: format.id,
    stageId: event.activeStageId ?? event.stages?.[0]?.id ?? "stage-main",
    valid: true,
    races,
  };
  event.rounds.push(round);
  return { round, note: plan.note ?? null };
};

const ordinal = (value) => {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  const mod10 = value % 10;
  if (mod10 === 1) return `${value}st`;
  if (mod10 === 2) return `${value}nd`;
  if (mod10 === 3) return `${value}rd`;
  return `${value}th`;
};

export const formatBoard = (event) => {
  const latest = event.rounds.at(-1);
  if (latest == null) return null;
  const stage = [];
  for (let index = event.rounds.length - 1; index >= 0; index -= 1) {
    if (event.rounds[index].format !== latest.format) break;
    stage.unshift(event.rounds[index]);
  }
  if (latest.format === "chase-the-ace") {
    const rows = event.pilots
      .map((pilot) => ({
        pilotId: pilot.id,
        name: pilot.name,
        values: [String(wins(event, pilot.id)), String(pointsTotal(event, pilot.id))],
      }))
      .sort((left, right) => Number(right.values[0]) - Number(left.values[0]) || Number(right.values[1]) - Number(left.values[1]));
    return { title: "Chase the ace", headings: ["Wins", "Points"], rows };
  }
  if (latest.format !== "double-elimination") return null;

  const previous = stage.at(-1);
  const rows = [];
  const eliminated = [];
  for (const pilot of event.pilots) {
    const bracket = bracketOf(previous, pilot.id);
    if (bracket === "Winners") {
      rows.push({ pilotId: pilot.id, name: pilot.name, values: ["Winners"] });
    } else if (bracket === "Losers" && topHalf(previous, pilot.id)) {
      rows.push({ pilotId: pilot.id, name: pilot.name, values: ["Losers"] });
    } else if (resultsFor(event, pilot.id).length > 0) {
      const raced = resultsFor(event, pilot.id);
      eliminated.push({
        pilot,
        races: raced.length,
        lastRound: raced.at(-1).round,
        lastPosition: raced.at(-1).position,
      });
    }
  }
  eliminated.sort(
    (left, right) =>
      left.races * 10000 +
      left.lastRound * 100 -
      left.lastPosition -
      (right.races * 10000 + right.lastRound * 100 - right.lastPosition),
  );
  eliminated.forEach((entry, index) => {
    entry.position = event.pilots.length - index;
  });
  for (let index = eliminated.length - 1; index >= 0; index -= 1) {
    const entry = eliminated[index];
    rows.push({
      pilotId: entry.pilot.id,
      name: entry.pilot.name,
      values: [ordinal(entry.position)],
    });
  }
  return { title: "Double elimination", headings: ["Status"], rows };
};

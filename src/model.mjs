import { randomUUID } from "node:crypto";
import { CHANNEL_CATALOG, CHANNEL_PACKS, catalogEntry, packById } from "./channels.mjs";

export { CHANNEL_PACKS };

/** RaceLib.Channel.InterferesWith: channels closer than 15 MHz cannot fly together. */
export const INTERFERENCE_MHZ = 15;

const CHANNEL_COLORS = [
  "#e23b3b",
  "#3b7de0",
  "#e0b43b",
  "#3cbe73",
  "#d45bd0",
  "#e07a32",
  "#7d6ae8",
  "#d5d8de",
];

export const interferes = (left, right) => {
  if (left == null || right == null) return false;
  return Math.abs(left.frequencyMhz - right.frequencyMhz) < INTERFERENCE_MHZ;
};

export const paintChannels = (channels) => {
  const sorted = [...channels].sort(
    (left, right) => left.frequencyMhz - right.frequencyMhz,
  );
  let colorIndex = 0;
  let previous = null;
  for (const channel of sorted) {
    if (previous != null && !interferes(channel, previous)) {
      colorIndex = (colorIndex + 1) % CHANNEL_COLORS.length;
    }
    channel.color = CHANNEL_COLORS[colorIndex];
    previous = channel;
  }
  return channels;
};

export const eventChannel = (catalogId) => {
  const entry = catalogEntry(catalogId);
  if (entry == null) return null;
  return {
    id: `ch-${entry.catalogId}`,
    catalogId: entry.catalogId,
    name: entry.name,
    band: entry.band,
    bandTitle: entry.bandTitle,
    bandType: entry.bandType,
    frequencyMhz: entry.frequencyMhz,
  };
};

export const channelsFromIds = (catalogIds) =>
  paintChannels(catalogIds.map(eventChannel).filter((channel) => channel != null));

export const channelsForPack = (packId) => {
  const pack = packById(packId);
  return pack == null ? null : channelsFromIds(pack.ids);
};

export const createEvent = (name = "Club race") => {
  const channels = channelsForPack("raceband");
  return {
    id: randomUUID(),
    name,
    laps: 4,
    pbLaps: 1,
    maxPilotsPerRace: 4,
    updatedAt: new Date().toISOString(),
    pilots: [],
    channels,
    rounds: [],
    mode: "Race",
    raceLengthSeconds: 120,
    theme: "night",
    sound: true,
    holeshot: true,
    captions: true,
    stages: [{ id: "stage-main", name: "Main", order: 1 }],
    activeStageId: "stage-main",
  };
};

/** Session rules follow RaceLib.Ext: HasLapCountLimit, HasPoints, HasResult, UsesTimingSystem. */
export const EVENT_MODES = [
  {
    id: "Race",
    title: "Race",
    detail: "Heats end when every pilot completes the target laps. Places score from the points table, and pilots short of the laps are DNF.",
  },
  {
    id: "TimeTrial",
    title: "Time trial",
    detail: "Pilots fly for the session length. The best run of target laps sets each place. No points.",
  },
  {
    id: "Practice",
    title: "Practice",
    detail: "Laps are timed for as long as you like. No places or points.",
  },
  {
    id: "CasualPractice",
    title: "Casual practice",
    detail: "Open practice with no start hold. Close it when you are done.",
  },
  {
    id: "Freestyle",
    title: "Freestyle",
    detail: "No gate timing. Close the session when the pack lands.",
  },
  {
    id: "Endurance",
    title: "Endurance",
    detail: "Most laps when the session clock runs out. Places score from the points table.",
  },
  {
    id: "Game",
    title: "Game",
    detail: "No gate laps. Each Point tap is a game point, and the most points wins the heat.",
  },
];

export const normalizeEvent = (event) => {
  event.mode ??= "Race";
  event.raceLengthSeconds ??= 120;
  event.theme ??= "night";
  event.sound ??= true;
  event.holeshot ??= true;
  event.captions ??= true;
  if (!Array.isArray(event.stages) || event.stages.length === 0) {
    event.stages = [{ id: "stage-main", name: "Main", order: 1 }];
  }
  event.activeStageId ??= event.stages[0].id;
  for (const round of event.rounds ?? []) round.stageId ??= event.stages[0].id;
  for (const channel of event.channels ?? []) {
    if (channel.catalogId != null) continue;
    const match = CHANNEL_CATALOG.find(
      (entry) => entry.frequencyMhz === channel.frequencyMhz && entry.name === channel.name,
    );
    if (match != null) {
      Object.assign(channel, { catalogId: match.catalogId, bandTitle: match.bandTitle, bandType: match.bandType });
    }
  }
  for (const round of event.rounds ?? []) {
    for (const race of round.races ?? []) {
      race.pauses ??= [];
      if (race.pausedAt === undefined) race.pausedAt = null;
      race.holeshot ??= true;
      race.raceLengthSeconds ??= event.raceLengthSeconds;
      for (const slot of race.slots ?? []) {
        slot.dnf ??= false;
        slot.crashed ??= false;
        slot.gamePoints ??= [];
      }
    }
  }
  return event;
};

export const deskStep = (event) => {
  if (event.pilots.length === 0) {
    return {
      id: "pilots",
      title: "Add pilots",
      text: "Put in everyone who is racing today. Two is enough to try a heat.",
    };
  }
  if (event.rounds.length === 0) {
    return {
      id: "format",
      title: "Draw the round",
      text: "Pick a format, then generate the heats. Pilots keep a channel when it still fits.",
    };
  }
  const open = event.rounds
    .flatMap((round) => round.races.map((race) => ({ round, race })))
    .find((entry) => entry.race.endedAt == null);
  if (open == null) {
    return {
      id: "next",
      title: "Draw the next round",
      text: "Every heat in this round has a result. Generate the next round when the field is ready.",
    };
  }
  if (open.race.startedAt == null) {
    return {
      id: "start",
      title: "Start the clock",
      text: "Seat the pilots on the coloured channels, then press Start. The horn sounds after a random hold, and the first gate after it is the holeshot.",
    };
  }
  return {
    id: "fly",
    title: "Call the gate",
    text: "Tap Lap, or press 1–8, each time that seat crosses the timing gate.",
  };
};

export const scoringLaps = (slot) =>
  slot.laps.filter((lap) => lap.number > 0 && lap.lengthSeconds > 0);

export const holeshotLap = (slot) =>
  slot.laps.find((lap) => lap.number === 0) ?? null;

export const pilotById = (event, pilotId) =>
  event.pilots.find((pilot) => pilot.id === pilotId) ?? null;

export const channelById = (event, channelId) =>
  event.channels.find((channel) => channel.id === channelId) ?? null;

export const findRace = (event, raceId) => {
  for (const round of event.rounds) {
    const race = round.races.find((candidate) => candidate.id === raceId);
    if (race != null) return { round, race };
  }
  return null;
};

export const lastChannelId = (event, pilotId) => {
  for (let index = event.rounds.length - 1; index >= 0; index -= 1) {
    for (const race of event.rounds[index].races) {
      const slot = race.slots.find((candidate) => candidate.pilotId === pilotId);
      if (slot != null) return slot.channelId;
    }
  }
  return null;
};

/**
 * Keep a pilot on the previous channel when that channel does not interfere
 * with anyone already seated in the heat.
 */
export const assignSlots = (event, pilotIds) => {
  const used = [];
  const slots = [];
  for (const pilotId of pilotIds) {
    const preferredId = lastChannelId(event, pilotId);
    const available = (channel) =>
      used.every((usedId) => {
        const other = channelById(event, usedId);
        return !interferes(channel, other);
      });
    const preferred = event.channels.find(
      (channel) => channel.id === preferredId && available(channel),
    );
    const channel =
      preferred ??
      [...event.channels]
        .sort((left, right) => left.frequencyMhz - right.frequencyMhz)
        .find(available);
    if (channel == null) {
      return {
        error: "Not enough non-interfering channels for this heat.",
      };
    }
    used.push(channel.id);
    slots.push({
      pilotId,
      channelId: channel.id,
      dnf: false,
      crashed: false,
      laps: [],
      gamePoints: [],
    });
  }
  return { slots };
};

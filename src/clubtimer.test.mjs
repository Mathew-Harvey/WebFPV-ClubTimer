import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CHANNEL_CATALOG, packById } from "./channels.mjs";
import { generateRound } from "./formats.mjs";
import { assignSlots, channelsForPack, createEvent, interferes } from "./model.mjs";
import { DEFAULT_POINTS, stageStandings } from "./points.mjs";
import { createApp } from "./server.mjs";
import {
  captionLines,
  clockSeconds,
  emergencyStop,
  finishRace,
  lapRecords,
  pauseRace,
  raceRules,
  recordLap,
  restartRace,
  resumeRace,
  startRace,
  tickRace,
} from "./timing.mjs";

const addPilot = (event, name) => {
  const pilot = { id: name, name };
  event.pilots.push(pilot);
  return pilot;
};

const quick = (eventType = "Race") => ({
  eventType,
  points: DEFAULT_POINTS,
  minLapSeconds: 0,
  startIgnoreSeconds: 0,
  startDelayMinSeconds: 0,
  startDelayMaxSeconds: 0,
});

const at = (start, ms) => new Date(start.getTime() + ms);
const START = new Date("2026-10-11T00:00:00.000Z");

const flyHeat = (race, names, lapsEach, rules = quick()) => {
  startRace(race, START, rules);
  names.forEach((name, index) => {
    for (let lap = 0; lap <= lapsEach; lap += 1) {
      recordLap(race, name, at(START, (lap + 1) * 10000 + index * 1000), rules);
    }
  });
};

test("seeded draw snakes registration order across heats", () => {
  const event = createEvent();
  event.maxPilotsPerRace = 3;
  for (const name of ["P1", "P2", "P3", "P4", "P5", "P6"]) addPilot(event, name);
  const result = generateRound(event, "seeded", () => 0);
  assert.equal(result.error, undefined);
  const heats = result.round.races.map((race) => race.slots.map((slot) => slot.pilotId));
  assert.deepEqual(heats, [
    ["P1", "P4", "P5"],
    ["P2", "P3", "P6"],
  ]);
});

test("random draw seats every pilot once", () => {
  const event = createEvent();
  for (const name of ["A", "B", "C", "D", "E"]) addPilot(event, name);
  const result = generateRound(event, "random-draw", () => 0.5);
  const seated = result.round.races.flatMap((race) => race.slots.map((slot) => slot.pilotId));
  assert.equal(seated.length, 5);
  assert.equal(new Set(seated).size, 5);
  assert.ok(result.round.races.every((race) => race.slots.length <= event.maxPilotsPerRace));
});

test("channels within 15 MHz cannot share a heat", () => {
  const event = createEvent();
  assert.equal(interferes({ frequencyMhz: 5800 }, { frequencyMhz: 5810 }), true);
  event.channels = [
    { id: "a", name: "A", frequencyMhz: 5800 },
    { id: "b", name: "B", frequencyMhz: 5810 },
  ];
  const assigned = assignSlots(event, ["p1", "p2"]);
  assert.match(assigned.error, /non-interfering/);
});

test("the channel catalog matches RaceLib's sets and short names", () => {
  assert.equal(CHANNEL_CATALOG.length, 105);
  const names = (packId) => channelsForPack(packId).map((channel) => `${channel.name}@${channel.frequencyMhz}`);
  assert.deepEqual(names("dji-o3"), ["DO1@5669", "DO2@5705", "DO3@5768", "DO4@5804", "DO5@5839", "DO6@5876", "DO7@5912"]);
  assert.deepEqual(names("hdzero-imd6c"), ["ZR1@5658", "ZR2@5695", "ZF2@5760", "ZF4@5800", "ZR7@5880", "ZR8@5917"]);
  assert.equal(names("hdzero-low")[0], "L1@5362");
  assert.deepEqual(names("dji-fpv-hd").slice(5), ["D6@5878", "D7@5914", "D8@5839"]);
  assert.deepEqual(packById("imd6c").ids, [9, 10, 2, 4, 15, 16]);
  assert.equal(channelsForPack("dji-fpv-hd")[0].bandType, "DJIDigital");
});

test("holeshot is excluded from the best scoring lap", () => {
  const event = createEvent();
  addPilot(event, "Ada");
  event.laps = 3;
  const race = generateRound(event, "seeded").round.races[0];
  startRace(race, START, quick());
  recordLap(race, "Ada", at(START, 1000), quick());
  recordLap(race, "Ada", at(START, 1600), quick());
  const record = lapRecords(event).find((row) => row.pilotId === "Ada");
  assert.equal(record.holeshot, 1);
  assert.equal(record.bestLap, 0.6);
});

test("the start horn follows a random hold, and early or quick gates are ignored", () => {
  const event = createEvent();
  addPilot(event, "Ada");
  const race = generateRound(event, "seeded").round.races[0];
  const rules = raceRules(event, null);
  assert.equal(rules.minLapSeconds, 5);
  assert.equal(rules.startIgnoreSeconds, 0.5);
  startRace(race, START, rules, () => 0.5);
  assert.equal(race.startHoldSeconds, 2.75);
  assert.match(recordLap(race, "Ada", at(START, 1000), rules).error, /horn/);
  assert.equal(recordLap(race, "Ada", at(START, 3000), rules).ignored, true);
  assert.equal(recordLap(race, "Ada", at(START, 4000), rules).ok, true);
  const quickLap = recordLap(race, "Ada", at(START, 7000), rules);
  assert.equal(quickLap.ignored, true);
  assert.match(quickLap.error, /minimum lap/);
  assert.equal(recordLap(race, "Ada", at(START, 12000), rules).ok, true);
  assert.equal(race.slots[0].laps.at(-1).lengthSeconds, 8);
});

test("race places score 10, 8, 6, 4, 2, 0 and short pilots are DNF", () => {
  const event = createEvent();
  event.laps = 2;
  for (const name of ["A", "B", "C", "D"]) addPilot(event, name);
  const race = generateRound(event, "seeded").round.races[0];
  flyHeat(race, ["A", "B", "C"], 2);
  recordLap(race, "D", at(START, 15000), quick());
  finishRace(race, at(START, 60000), quick());
  const points = Object.fromEntries(race.slots.map((slot) => [slot.pilotId, [slot.position, slot.points, slot.resultDnf]]));
  assert.deepEqual(points, { A: [1, 10, false], B: [2, 8, false], C: [3, 6, false], D: [4, 0, true] });
});

test("double elimination opens a winners heat and a losers heat", () => {
  const event = createEvent();
  event.maxPilotsPerRace = 4;
  event.laps = 1;
  for (const name of ["A", "B", "C", "D"]) addPilot(event, name);
  const first = generateRound(event, "double-elimination");
  assert.equal(first.round.races.length, 1);
  assert.equal(first.round.races[0].bracket, "Winners");
  const race = first.round.races[0];
  flyHeat(race, ["A", "B", "C", "D"], 1);
  assert.equal(race.slots.find((slot) => slot.pilotId === "A").position, 1);
  assert.equal(race.slots.find((slot) => slot.pilotId === "A").points, 10);
  assert.equal(race.slots.find((slot) => slot.pilotId === "D").points, 4);
  const second = generateRound(event, "double-elimination");
  const brackets = second.round.races.map((heat) => heat.bracket);
  assert.deepEqual(brackets, ["Winners", "Losers"]);
});

test("chase the ace stops after two wins", () => {
  const event = createEvent();
  event.laps = 1;
  event.maxPilotsPerRace = 2;
  addPilot(event, "Ace");
  addPilot(event, "Bee");
  for (let round = 0; round < 2; round += 1) {
    const generated = generateRound(event, "chase-the-ace");
    assert.ok(generated.round);
    flyHeat(generated.round.races[0], ["Ace", "Bee"], 1);
  }
  const stopped = generateRound(event, "chase-the-ace");
  assert.match(stopped.stop, /Ace/);
  assert.equal(event.rounds.length, 2);
});

test("a time trial ranks by the best run of target laps and scores no points", () => {
  const event = createEvent();
  event.mode = "TimeTrial";
  event.laps = 2;
  for (const name of ["Slow", "Fast"]) addPilot(event, name);
  const race = generateRound(event, "seeded").round.races[0];
  const rules = quick("TimeTrial");
  startRace(race, START, rules);
  for (const [name, laps] of [["Slow", [1000, 11000, 21000, 31000]], ["Fast", [1500, 8500, 15500, 30000]]]) {
    for (const ms of laps) recordLap(race, name, at(START, ms), rules);
  }
  tickRace(race, rules, at(START, 120000));
  assert.ok(race.endedAt);
  const slot = (name) => race.slots.find((item) => item.pilotId === name);
  assert.equal(slot("Fast").position, 1);
  assert.equal(slot("Fast").points, 0);
  assert.equal(slot("Slow").laps.length, 4);
});

test("a stage summary drops the worst round and carries places from the stage before", () => {
  const event = createEvent();
  event.laps = 1;
  for (const name of ["A", "B"]) addPilot(event, name);
  for (const order of [["A", "B"], ["B", "A"], ["A", "B"]]) {
    flyHeat(generateRound(event, "seeded").round.races[0], order, 1);
  }
  event.stages[0].pointSummary = { dropWorstRound: true, roundPositionRollover: false };
  const main = stageStandings(event)[0];
  const row = (stage, name) => stage.rows.find((item) => item.pilotId === name);
  assert.equal(row(main, "A").total, 20);
  assert.equal(row(main, "B").total, 18);
  assert.ok(row(main, "A").dropped);
  event.stages.push({ id: "finals", name: "Finals", order: 2, pointSummary: { dropWorstRound: false, roundPositionRollover: true } });
  event.activeStageId = "finals";
  flyHeat(generateRound(event, "seeded").round.races[0], ["B", "A"], 1);
  const finals = stageStandings(event)[1];
  assert.equal(row(finals, "A").rollover.points, 10);
  assert.equal(row(finals, "A").total, 18);
  assert.equal(row(finals, "B").total, 18);
  assert.equal(row(finals, "A").position, 1);
  assert.equal(row(finals, "B").position, 1);
});

test("a game heat counts game points instead of laps", () => {
  const event = createEvent();
  event.mode = "Game";
  for (const name of ["Ada", "Bo"]) addPilot(event, name);
  const race = generateRound(event, "seeded").round.races[0];
  const rules = quick("Game");
  startRace(race, START, rules);
  recordLap(race, "Bo", at(START, 1000), rules);
  recordLap(race, "Bo", at(START, 2000), rules);
  recordLap(race, "Ada", at(START, 3000), rules);
  finishRace(race, at(START, 4000), rules);
  const slot = (name) => race.slots.find((item) => item.pilotId === name);
  assert.equal(slot("Bo").gamePoints.length, 2);
  assert.equal(slot("Bo").laps.length, 0);
  assert.equal(slot("Bo").position, 1);
});

test("a pause is left out of the next lap", () => {
  const event = createEvent();
  addPilot(event, "Ada");
  const race = generateRound(event, "seeded").round.races[0];
  startRace(race, START, quick());
  recordLap(race, "Ada", at(START, 1000), quick());
  pauseRace(race, at(START, 2000));
  assert.equal(clockSeconds(race, at(START, 9000)), 2);
  resumeRace(race, at(START, 5000));
  recordLap(race, "Ada", at(START, 6000), quick());
  assert.equal(race.slots[0].laps[1].lengthSeconds, 2);
});

test("endurance ends when the clock runs out and scores places", () => {
  const event = createEvent();
  event.mode = "Endurance";
  event.raceLengthSeconds = 30;
  addPilot(event, "Ada");
  const race = generateRound(event, "seeded").round.races[0];
  startRace(race, START, quick("Endurance"));
  tickRace(race, quick("Endurance"), at(START, 30000));
  assert.ok(race.endedAt);
  assert.equal(race.slots[0].points, 10);
});

test("emergency stop marks unfinished pilots DNF and can be restarted", () => {
  const event = createEvent();
  event.laps = 1;
  for (const name of ["Ada", "Bo"]) addPilot(event, name);
  const race = generateRound(event, "seeded").round.races[0];
  startRace(race, START, quick());
  recordLap(race, "Ada", at(START, 1000), quick());
  recordLap(race, "Ada", at(START, 2000), quick());
  emergencyStop(race, at(START, 3000), quick());
  assert.equal(race.emergency, true);
  assert.equal(race.slots.find((slot) => slot.pilotId === "Bo").dnf, true);
  assert.equal(race.slots.find((slot) => slot.pilotId === "Ada").dnf, false);
  assert.match(captionLines(event).at(-1).text, /emergency stop/);
  assert.equal(restartRace(race).ok, true);
  assert.equal(race.startedAt, null);
  assert.equal(race.slots[0].laps.length, 0);
});

test("a new stage keeps the next round separate", () => {
  const event = createEvent();
  addPilot(event, "Ada");
  const first = generateRound(event, "seeded").round;
  first.races[0].startedAt = "2026-10-11T00:00:00.000Z";
  first.races[0].endedAt = "2026-10-11T00:01:00.000Z";
  event.stages.push({ id: "finals", name: "Finals", order: 2 });
  event.activeStageId = "finals";
  const second = generateRound(event, "abc-finals").round;
  assert.equal(first.stageId, "stage-main");
  assert.equal(second.stageId, "finals");
});

test("the desk serves a generated round and takes a detector's gate time", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "club-")), "event.json");
  const server = createApp(file);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const post = (url, body, method = "POST") =>
    fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Race desk/);
    assert.equal((await fetch(`${base}/no-such-file.js`)).status, 404);
    await post("/api/pilots", { name: "Nova" });
    await post("/api/event", { startDelayMinSeconds: 0, startDelayMaxSeconds: 0, minLapSeconds: 0, startIgnoreSeconds: 0 }, "PATCH");
    const generated = await post("/api/rounds", { format: "seeded" });
    const body = await generated.json();
    assert.equal(generated.status, 200);
    const race = body.event.rounds[0].races[0];
    const pilotId = race.slots[0].pilotId;
    const started = await (await post(`/api/races/${race.id}/start`, {})).json();
    const startedAt = Date.parse(started.event.rounds[0].races[0].startedAt);
    const early = await post(`/api/races/${race.id}/lap`, { pilotId, at: "2000-01-01T00:00:00.000Z" });
    assert.equal(early.status, 400);
    assert.equal((await early.json()).ignored, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const seen = new Date(startedAt + 20).toISOString();
    const lap = await (await post(`/api/races/${race.id}/lap`, { pilotId, at: seen })).json();
    assert.equal(lap.event.rounds[0].races[0].slots[0].laps[0].endedAt, seen);
    const points = await post("/api/event", { positionPoints: "25, 18, 15" }, "PATCH");
    assert.deepEqual((await points.json()).rules.points.positionPoints, [25, 18, 15]);
    const bad = await post("/api/event", { positionPoints: "ten" }, "PATCH");
    assert.equal(bad.status, 400);
    const spectator = await fetch(`${base}/spectator.html`);
    assert.match(await spectator.text(), /Spectator/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

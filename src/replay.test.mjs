import assert from "node:assert/strict";
import test from "node:test";
import { cursorAt, describeEvent, replayEvents, standingsAt } from "../public/replay.js";

const race = {
  startedAt: "2026-10-11T00:00:00.000Z",
  endedAt: "2026-10-11T00:00:40.000Z",
  pauses: [{ start: "2026-10-11T00:00:12.000Z", end: "2026-10-11T00:00:15.000Z" }],
  slots: [
    {
      pilotId: "ada",
      channelId: "ch-9",
      laps: [
        { number: 0, lengthSeconds: 2, endedAt: "2026-10-11T00:00:02.000Z" },
        { number: 1, lengthSeconds: 10, endedAt: "2026-10-11T00:00:15.000Z" },
      ],
    },
    {
      pilotId: "bo",
      channelId: "ch-10",
      laps: [
        { number: 0, lengthSeconds: 3, endedAt: "2026-10-11T00:00:03.000Z" },
        { number: 1, lengthSeconds: 8, endedAt: "2026-10-11T00:00:11.000Z" },
        { number: 2, lengthSeconds: 20, endedAt: "2026-10-11T00:00:34.000Z" },
      ],
    },
  ],
};

test("replay events run on the heat clock with pauses removed", () => {
  const events = replayEvents(race);
  assert.deepEqual(events.map((event) => [event.kind, event.pilotId ?? null, event.t]), [
    ["holeshot", "ada", 2],
    ["holeshot", "bo", 3],
    ["lap", "bo", 11],
    ["lap", "ada", 12],
    ["lap", "bo", 31],
    ["end", null, 37],
  ]);
});

test("places at a moment follow laps, then who got there first", () => {
  const events = replayEvents(race);
  assert.deepEqual(standingsAt(race, events, 11.5).map((row) => row.pilotId), ["bo", "ada"]);
  assert.deepEqual(standingsAt(race, events, 12).map((row) => [row.pilotId, row.laps]), [["bo", 1], ["ada", 1]]);
  assert.equal(standingsAt(race, events, 31)[0].laps, 2);
  assert.equal(cursorAt(events, 0), -1);
  assert.equal(cursorAt(events, 12), 3);
  assert.equal(describeEvent(events[3], (id) => id.toUpperCase()), "ADA lap 1 0:10.000");
});

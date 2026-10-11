import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCamera } from "./camera-api.mjs";
import { generateRound } from "./formats.mjs";
import { createEvent } from "./model.mjs";
import { createApp } from "./server.mjs";
import { finishRace, raceRules, startRace } from "./timing.mjs";

const START = new Date("2026-10-11T00:00:00.000Z");
const after = (ms) => new Date(START.getTime() + ms);

const runningHeat = () => {
  const event = createEvent();
  event.pilots.push({ id: "ada", name: "Ada" }, { id: "bo", name: "Bo" });
  const { round } = generateRound(event, "seeded", () => 0);
  const race = round.races[0];
  startRace(race, START, raceRules(event, round), () => 0);
  return { event, round, race, slot: race.slots[0], start: Date.parse(race.startedAt) };
};

const post = (event, race, action, body, now) =>
  applyCamera(event, "POST", `/api/races/${race.id}/${action}`, body, now);

test("requests that are not camera calls fall through to the desk", () => {
  const { event, race } = runningHeat();
  assert.equal(applyCamera(event, "POST", `/api/races/${race.id}/lap`, {}), null);
  assert.equal(applyCamera(event, "GET", `/api/races/${race.id}/detect`, {}), null);
});

test("a detection records the lap at the moment the markers vanished", () => {
  const { event, race, slot, start } = runningHeat();
  const holeshot = post(event, race, "detect", { channelId: slot.channelId, at: start + 1500, peak: 2400.7 }, after(10_000));
  assert.equal(holeshot.ok, true);
  assert.deepEqual(
    { endedAt: slot.laps[0].endedAt, source: slot.laps[0].source, peakPx: slot.laps[0].peakPx },
    { endedAt: new Date(start + 1500).toISOString(), source: "camera", peakPx: 2401 },
  );
  const lap = post(event, race, "detect", { channelId: slot.channelId, at: new Date(start + 9000).toISOString() }, after(12_000));
  assert.equal(lap.ok, true);
  assert.equal(slot.laps[1].lengthSeconds, 7.5);
  const tooQuick = post(event, race, "detect", { channelId: slot.channelId, at: start + 11_000 }, after(12_000));
  assert.equal(tooQuick.ignored, true);
  assert.equal(slot.laps.length, 2);
});

test("detections are checked against the heat and the clock", () => {
  const { event, race, slot, start } = runningHeat();
  assert.equal(post(event, race, "detect", { channelId: "nobody", at: start + 1000 }, after(5000)).error, "No pilot is on that channel in this heat.");
  assert.equal(applyCamera(event, "POST", "/api/races/missing/detect", { channelId: slot.channelId }).status, 404);
  assert.equal(post(event, race, "detect", { channelId: slot.channelId }, after(5000)).error, "The detection time is missing.");
  assert.equal(
    post(event, race, "detect", { channelId: slot.channelId, at: START.getTime() + 11_001 }, after(6000)).error,
    "The detection time is in the future.",
  );
});

test("the video static detector crashes a pilot out and brings them back", () => {
  const { event, round, race, slot } = runningHeat();
  assert.equal(post(event, race, "autocrash", { channelId: slot.channelId, crashed: true }, after(4000)).ok, true);
  assert.equal(slot.crashed, true);
  assert.equal(post(event, race, "autocrash", { channelId: slot.channelId, crashed: false }, after(8000)).ok, true);
  assert.equal(slot.crashed, false);
  assert.equal(post(event, race, "autocrash", { channelId: slot.channelId, crashed: "maybe" }, after(8000)).error, "Send crashed as true or false.");
  finishRace(race, after(9000), raceRules(event, round));
  assert.equal(post(event, race, "autocrash", { channelId: slot.channelId, crashed: false }, after(9500)).error, "The heat is not running.");
});

test("finished or DNF pilots are never crashed out by still video", () => {
  const { event, race, slot, start } = runningHeat();
  slot.dnf = true;
  assert.equal(post(event, race, "autocrash", { channelId: slot.channelId, crashed: true }, after(4000)).error, "That pilot is marked DNF.");
  slot.dnf = false;
  race.targetLaps = 1;
  post(event, race, "detect", { channelId: slot.channelId, at: start + 1000 }, after(3000));
  post(event, race, "detect", { channelId: slot.channelId, at: start + 7000 }, after(8000));
  assert.equal(
    post(event, race, "autocrash", { channelId: slot.channelId, crashed: true }, after(9000)).error,
    "That pilot has already finished the target laps.",
  );
  assert.equal(slot.crashed, false);
});

test("the desk server accepts camera detections", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "club-camera-")), "event.json");
  const server = createApp(file);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (url, body, method = "POST") => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await send("/api/event", { startDelayMinSeconds: 0, startDelayMaxSeconds: 0, startIgnoreSeconds: 0 }, "PATCH");
    await send("/api/pilots", { name: "Ada" });
    const drawn = await send("/api/rounds", { format: "seeded" });
    const race = drawn.body.event.rounds[0].races[0];
    await send(`/api/races/${race.id}/start`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const detected = await send(`/api/races/${race.id}/detect`, { channelId: race.slots[0].channelId, at: Date.now() });
    assert.equal(detected.status, 200, detected.body.error);
    assert.equal(detected.body.event.rounds[0].races[0].slots[0].laps[0].source, "camera");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

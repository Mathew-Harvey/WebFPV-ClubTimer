import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildRound } from "./formats.mjs";
import { listScripts, runScriptRound, runScriptStandings } from "./lua-host.mjs";
import { createEvent } from "./model.mjs";
import { DEFAULT_POINTS } from "./points.mjs";
import { recordLap, startRace } from "./timing.mjs";

const quick = { eventType: "Race", points: DEFAULT_POINTS, minLapSeconds: 0, startIgnoreSeconds: 0, startDelayMinSeconds: 0, startDelayMaxSeconds: 0 };

const scriptsFrom = (files) => {
  const dir = mkdtempSync(path.join(tmpdir(), "lua-"));
  for (const [file, source] of Object.entries(files)) writeFileSync(path.join(dir, file), source);
  return listScripts(dir);
};

const eventWith = (names) => {
  const event = createEvent();
  event.laps = 1;
  event.pilots = names.map((name) => ({ id: name.toLowerCase(), name }));
  return event;
};

const flyRound = (event, start) => {
  for (const race of event.rounds.at(-1).races) {
    startRace(race, start, quick);
    race.slots.forEach((slot, seat) => {
      for (let lap = 0; lap <= race.targetLaps; lap += 1) {
        recordLap(race, slot.pilotId, new Date(start.getTime() + (lap + 1) * 10000 + seat * 500), quick);
      }
    });
  }
};

const BRACKETS = `
name = "Top half up"
description = "Winners of the last round race for the A final."
function generate(round, pilots, channels, options)
  if is_first_round() then
    return { { bracket = "Winners", target_laps = 3, pilots = map(pilots, function(p) return p.id end) } }
  end
  if not all_results_in() then return nil end
  round.name = "Final " .. round.stage_index
  local a, b = {}, {}
  for _, p in ipairs(pilots_with_results(pilots)) do
    if top_half(p.id) then table.insert(a, p.id) else table.insert(b, p.id) end
  end
  log("A " .. #a .. " B " .. #b)
  return { { bracket = "A", pilots = a }, { bracket = "B", pilots = sort_by(b, function(id) return -get_best_consecutive_laps(id, 1) end) } }
end
function standings(pilots, options)
  local rows = {}
  for _, p in ipairs(sort_by(pilots, function(p) return -sum(get_results(p.id), function(r) return r.points end) end)) do
    table.insert(rows, { pilot_id = p.id, name = p.name, values = { get_bracket(p.id), tostring(sum(get_results(p.id), function(r) return r.points end)) } })
  end
  return { headings = { "Last bracket", "Points" }, rows = rows }
end
`;

test("a script round seats brackets, target laps and a renamed round", () => {
  const [script] = scriptsFrom({ "top_half.lua": BRACKETS });
  assert.equal(script.name, "Top half up");
  assert.equal(script.standings, true);
  const event = eventWith(["Ada", "Bo", "Cy", "Dee"]);
  const first = runScriptRound(event, script);
  const round = buildRound(event, { id: script.id, name: script.name }, first).round;
  assert.equal(round.races[0].bracket, "Winners");
  assert.equal(round.races[0].targetLaps, 3);
  assert.match(runScriptRound(event, script).stop, /no heats/);
  flyRound(event, new Date("2026-10-11T00:00:00Z"));
  const second = runScriptRound(event, script);
  assert.match(second.note, /A 2 B 2/);
  assert.equal(second.name, "Final 2");
  const final = buildRound(event, { id: script.id, name: script.name }, second).round;
  assert.deepEqual(final.races.map((race) => [race.bracket, race.slots.map((slot) => slot.pilotId)]), [
    ["A", ["ada", "bo"]],
    ["B", ["cy", "dee"]],
  ]);
  assert.equal(final.name, "Final 2");
  const card = runScriptStandings(event, script, event.activeStageId);
  assert.deepEqual(card.headings, ["Last bracket", "Points"]);
  assert.deepEqual(card.rows[0], { pilotId: "ada", name: "Ada", values: ["A", "10"] });
});

test("a runaway or broken script is stopped with a readable error", () => {
  const scripts = scriptsFrom({
    "loop.lua": 'name = "Loop"\nfunction generate() while true do end end',
    "format.lua": 'name = "Wide"\nfunction generate() return { { string.format("%.500f", 1) } } end',
    "syntax.lua": "function generate( return",
    "nogenerate.lua": 'name = "Nothing"',
  });
  const event = eventWith(["Ada", "Bo"]);
  const byFile = Object.fromEntries(scripts.map((script) => [script.file, script]));
  assert.match(runScriptRound(event, byFile["loop.lua"]).error, /too long/);
  assert.match(runScriptRound(event, byFile["format.lua"]).error, /precision/);
  assert.match(byFile["syntax.lua"].error, /syntax\.lua|expected/);
  assert.match(byFile["nogenerate.lua"].error, /no generate/);
});

test("the bundled example script draws even heats", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
  const script = listScripts(dir).find((item) => item.file === "fresh_matchups.lua");
  assert.equal(script.error, null);
  const event = eventWith(["A", "B", "C", "D", "E", "F"]);
  const plan = runScriptRound(event, script, () => 0.3);
  assert.deepEqual(plan.races.map((race) => race.pilotIds.length).sort(), [3, 3]);
});

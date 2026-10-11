import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import fengari from "fengari";
import { INTERFERENCE_MHZ, scoringLaps } from "./model.mjs";

const { lua, lauxlib, lualib, to_luastring: luaString } = fengari;

/** Lua 5.2 code in FPVTrackside runs on MoonSharp; these limits keep a bad script from stalling the desk. */
const INSTRUCTION_BUDGET = 50_000_000;
const TIME_BUDGET_MS = 2000;

const EVENT_TYPES = ["Race", "TimeTrial", "Practice", "Freestyle", "Endurance", "CasualPractice", "Game"];
const BRACKETS = ["None", "Winners", "Losers", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** SCRIPTING.md list helpers, written in Lua so they can call script functions directly. */
const PRELUDE = `
do
  local format = string.format
  string.format = function(pattern, ...)
    if type(pattern) == "string" and pattern:find("%%[%-+ #0]*%d*%.%d%d%d") then
      error("string.format precision is limited to 99 digits", 2)
    end
    return format(pattern, ...)
  end
end
function ordinal(n)
  local mod100 = n % 100
  if mod100 >= 11 and mod100 <= 13 then return n .. "th" end
  local mod10 = n % 10
  if mod10 == 1 then return n .. "st" end
  if mod10 == 2 then return n .. "nd" end
  if mod10 == 3 then return n .. "rd" end
  return n .. "th"
end
function shuffle(list)
  local copy = {}
  for i, v in ipairs(list) do copy[i] = v end
  for i = #copy, 2, -1 do
    local j = math.random(i)
    copy[i], copy[j] = copy[j], copy[i]
  end
  return copy
end
function map(list, fn)
  local out = {}
  for i, v in ipairs(list) do out[i] = fn(v) end
  return out
end
function filter(list, fn)
  local out = {}
  for _, v in ipairs(list) do if fn(v) then out[#out + 1] = v end end
  return out
end
local function key(fn, v) if fn == nil then return v end return fn(v) end
function sum(list, fn)
  local total = 0
  for _, v in ipairs(list) do total = total + key(fn, v) end
  return total
end
function average(list, fn)
  if #list == 0 then return 0 end
  return sum(list, fn) / #list
end
function min(list, fn)
  local best, bestKey = nil, nil
  for _, v in ipairs(list) do
    local k = key(fn, v)
    if best == nil or k < bestKey then best, bestKey = v, k end
  end
  return best
end
function max(list, fn)
  local best, bestKey = nil, nil
  for _, v in ipairs(list) do
    local k = key(fn, v)
    if best == nil or k > bestKey then best, bestKey = v, k end
  end
  return best
end
function sort_by(list, fn)
  local decorated = {}
  for i, v in ipairs(list) do decorated[i] = { v = v, k = fn(v), i = i } end
  table.sort(decorated, function(a, b)
    if a.k == b.k then return a.i < b.i end
    return a.k < b.k
  end)
  local out = {}
  for i, d in ipairs(decorated) do out[i] = d.v end
  return out
end
`;

const roundResults = (round, pilotId) => {
  const out = [];
  if (round == null) return out;
  for (const race of round.races) {
    if (race.endedAt == null) continue;
    const slot = race.slots.find((item) => item.pilotId === pilotId);
    if (slot == null || slot.position == null) continue;
    out.push({
      points: slot.points ?? 0,
      position: slot.position,
      laps: scoringLaps(slot).length,
      dnf: slot.dnf === true || slot.resultDnf === true,
      round: round.number,
      time: slot.laps.reduce((total, lap) => total + lap.lengthSeconds, 0),
    });
  }
  return out;
};

const channelGroups = (channels) => {
  const sorted = [...channels].sort((left, right) => left.frequencyMhz - right.frequencyMhz);
  const groups = new Map();
  let group = 0;
  let previous = null;
  for (const channel of sorted) {
    if (previous == null || Math.abs(channel.frequencyMhz - previous.frequencyMhz) >= INTERFERENCE_MHZ) group += 1;
    groups.set(channel.id, group);
    previous = channel;
  }
  return groups;
};

/** Everything a script can ask about the meet, relative to one anchor round. */
const scriptContext = (event, { anchor, stageId }) => {
  const rounds = event.rounds;
  const stageRounds = rounds.slice(0, anchor).filter((round) => round.stageId === stageId);
  const roundAt = (offset = -1) => (offset >= 0 ? null : rounds[anchor + offset] ?? null);
  const groups = channelGroups(event.channels);
  const channelTable = (channel) =>
    channel == null
      ? null
      : {
          id: channel.id,
          name: channel.name,
          band: channel.bandTitle ?? channel.band,
          band_type: channel.bandType ?? "Analogue",
          channel_group_id: groups.get(channel.id) ?? 0,
        };
  const pilotTable = (pilot) => ({ id: pilot.id, name: pilot.name });
  const raceOf = (round, pilotId) =>
    round?.races.find((race) => race.slots.some((slot) => slot.pilotId === pilotId)) ?? null;
  const windowRounds = (from, to = -1) => {
    const first = from == null ? 0 : Math.max(0, anchor + from);
    const last = Math.min(anchor - 1, anchor + to);
    return rounds.slice(first, last + 1);
  };
  const lastChannelId = (pilotId, offset = -1) => {
    const race = raceOf(roundAt(offset), pilotId);
    return race?.slots.find((slot) => slot.pilotId === pilotId)?.channelId ?? null;
  };
  const roundInfo = (round) =>
    round == null
      ? null
      : {
          number: round.number,
          event_type: round.eventType,
          name: round.name,
          stage_index: rounds.filter((item, index) => item.stageId === round.stageId && index <= rounds.indexOf(round)).length,
        };
  return {
    stageRounds,
    log: [],
    helpers: {
      history: (a, b) =>
        rounds.reduce(
          (count, round) =>
            count + round.races.filter((race) => race.slots.some((s) => s.pilotId === a) && race.slots.some((s) => s.pilotId === b)).length,
          0,
        ),
      minimise_channel_change: (pilotIds) => {
        const ids = Array.isArray(pilotIds) ? pilotIds : [];
        return [...ids].sort((left, right) => (lastChannelId(right) != null) - (lastChannelId(left) != null));
      },
      get_results: (pilotId, from, to) => windowRounds(from, to).flatMap((round) => roundResults(round, pilotId)),
      has_any_results: (offset = -1) => roundAt(offset)?.races.some((race) => race.endedAt != null) ?? false,
      all_results_in: (offset = -1) => {
        const round = roundAt(offset);
        return round != null && round.races.length > 0 && round.races.every((race) => race.endedAt != null);
      },
      has_result: (pilotId, offset = -1) => roundResults(roundAt(offset), pilotId).length > 0,
      pilots_with_results: (pilots, offset = -1) =>
        (Array.isArray(pilots) ? pilots : []).filter((pilot) => roundResults(roundAt(offset), pilot?.id).length > 0),
      top_half: (pilotId, offset = -1) => {
        const race = raceOf(roundAt(offset), pilotId);
        if (race == null) return false;
        if (race.endedAt == null) return true;
        const slot = race.slots.find((item) => item.pilotId === pilotId);
        return (slot.position ?? Number.POSITIVE_INFINITY) <= Math.ceil(race.slots.length / 2);
      },
      is_first_round: () => stageRounds.length === 0,
      get_pilots_in_event: () => event.pilots.map(pilotTable),
      get_pilots_in_round: (offset = -1) => {
        const round = roundAt(offset);
        const ids = new Set(round?.races.flatMap((race) => race.slots.map((slot) => slot.pilotId)) ?? []);
        return event.pilots.filter((pilot) => ids.has(pilot.id)).map(pilotTable);
      },
      get_round_info: (offset = -1) => roundInfo(roundAt(offset)),
      get_round_by_stage_index: (index) => roundInfo(stageRounds[Number(index) - 1] ?? null),
      get_unflown_pilots: (pilotId) =>
        event.pilots
          .filter((pilot) => pilot.id !== pilotId)
          .filter((pilot) => !rounds.some((round) => round.races.some((race) =>
            race.slots.some((s) => s.pilotId === pilotId) && race.slots.some((s) => s.pilotId === pilot.id))))
          .map(pilotTable),
      get_bracket: (pilotId, offset = -1) => raceOf(roundAt(offset), pilotId)?.bracket ?? "None",
      get_best_consecutive_laps: (pilotId, count, from, to) => {
        let best = 0;
        const size = Math.max(1, Number(count) || 1);
        for (const round of windowRounds(from, to)) {
          for (const race of round.races) {
            const slot = race.slots.find((item) => item.pilotId === pilotId);
            if (slot == null) continue;
            const laps = [...scoringLaps(slot)].sort((left, right) => left.number - right.number);
            for (let index = 0; index + size <= laps.length; index += 1) {
              const time = laps.slice(index, index + size).reduce((total, lap) => total + lap.lengthSeconds, 0);
              if (best === 0 || time < best) best = time;
            }
          }
        }
        return best;
      },
      get_channels: () => event.channels.map(channelTable),
      get_last_channel: (pilotId, offset = -1) =>
        channelTable(event.channels.find((channel) => channel.id === lastChannelId(pilotId, offset)) ?? null),
      get_interfering_channels: (channelId) => {
        const channel = event.channels.find((item) => item.id === channelId);
        if (channel == null) return [];
        return event.channels
          .filter((item) => item.id !== channel.id && Math.abs(item.frequencyMhz - channel.frequencyMhz) < INTERFERENCE_MHZ)
          .map(channelTable);
      },
      count_channel_changes: (pilotId) => {
        let changes = 0;
        let previous = null;
        for (const round of rounds) {
          for (const race of round.races) {
            const slot = race.slots.find((item) => item.pilotId === pilotId);
            if (slot == null) continue;
            if (previous != null && slot.channelId !== previous) changes += 1;
            previous = slot.channelId;
          }
        }
        return changes;
      },
    },
  };
};

const pushValue = (L, value) => {
  if (value == null) lua.lua_pushnil(L);
  else if (typeof value === "boolean") lua.lua_pushboolean(L, value);
  else if (typeof value === "number") {
    if (Number.isInteger(value)) lua.lua_pushinteger(L, value);
    else lua.lua_pushnumber(L, value);
  } else if (typeof value === "string") lua.lua_pushstring(L, luaString(value));
  else if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((item, index) => {
      pushValue(L, item);
      lua.lua_rawseti(L, -2, index + 1);
    });
  } else {
    lua.lua_createtable(L, 0, Object.keys(value).length);
    for (const [key, item] of Object.entries(value)) {
      pushValue(L, item);
      lua.lua_setfield(L, -2, luaString(key));
    }
  }
};

/** Lua value at idx to JS: tables with a 1..n array part become arrays, keyed tables become objects. */
const readValue = (L, idx, depth = 0) => {
  const type = lua.lua_type(L, idx);
  if (type === lua.LUA_TNIL || type === lua.LUA_TNONE) return null;
  if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx);
  if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
  if (type === lua.LUA_TSTRING) return lua.lua_tojsstring(L, idx);
  if (type !== lua.LUA_TTABLE || depth > 8) return null;
  const at = lua.lua_absindex(L, idx);
  const length = lua.lua_rawlen(L, at);
  const array = [];
  for (let index = 1; index <= length; index += 1) {
    lua.lua_rawgeti(L, at, index);
    array.push(readValue(L, -1, depth + 1));
    lua.lua_pop(L, 1);
  }
  const fields = {};
  let keyed = false;
  lua.lua_pushnil(L);
  while (lua.lua_next(L, at) !== 0) {
    if (lua.lua_type(L, -2) === lua.LUA_TSTRING) {
      fields[lua.lua_tojsstring(L, -2)] = readValue(L, -1, depth + 1);
      keyed = true;
    }
    lua.lua_pop(L, 1);
  }
  if (!keyed) return array;
  if (array.length > 0) fields[Symbol.for("array")] = array;
  return fields;
};

const arrayPart = (value) => (Array.isArray(value) ? value : value?.[Symbol.for("array")] ?? []);

class ScriptError extends Error {}

const newState = (random) => {
  const L = lauxlib.luaL_newstate();
  for (const [name, open] of [
    ["_G", lualib.luaopen_base],
    [lualib.LUA_TABLIBNAME, lualib.luaopen_table],
    [lualib.LUA_STRLIBNAME, lualib.luaopen_string],
    [lualib.LUA_MATHLIBNAME, lualib.luaopen_math],
    [lualib.LUA_UTF8LIBNAME, lualib.luaopen_utf8],
  ]) {
    lauxlib.luaL_requiref(L, luaString(name), open, 1);
    lua.lua_pop(L, 1);
  }
  for (const unsafe of ["dofile", "loadfile", "load", "require", "collectgarbage"]) {
    lua.lua_pushnil(L);
    lua.lua_setglobal(L, luaString(unsafe));
  }
  const started = Date.now();
  let count = 0;
  lua.lua_sethook(L, (state) => {
    count += 1000;
    if (count > INSTRUCTION_BUDGET || Date.now() - started > TIME_BUDGET_MS) {
      lauxlib.luaL_error(state, luaString("the script ran too long and was stopped"));
    }
  }, lua.LUA_MASKCOUNT, 1000);
  run(L, PRELUDE, "prelude");
  lua.lua_getglobal(L, luaString("math"));
  lua.lua_getfield(L, -1, luaString("randomseed"));
  lua.lua_pushinteger(L, Math.floor(random() * 2 ** 31));
  lua.lua_call(L, 1, 0);
  lua.lua_pop(L, 1);
  return L;
};

const errorText = (L) => {
  const message = lua.lua_type(L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : "unknown error";
  lua.lua_pop(L, 1);
  return message;
};

const run = (L, source, name) => {
  if (lauxlib.luaL_loadbuffer(L, luaString(source), null, luaString(`=${name}`)) !== lua.LUA_OK) {
    throw new ScriptError(errorText(L));
  }
  if (lua.lua_pcall(L, 0, 0, 0) !== lua.LUA_OK) throw new ScriptError(errorText(L));
};

const registerHelpers = (L, context) => {
  lua.lua_pushjsfunction(L, (state) => {
    const parts = [];
    for (let index = 1; index <= lua.lua_gettop(state); index += 1) {
      parts.push(lauxlib.luaL_tolstring(state, index) && lua.lua_tojsstring(state, -1));
      lua.lua_pop(state, 1);
    }
    context.log.push(parts.join(" "));
    return 0;
  });
  lua.lua_setglobal(L, luaString("log"));
  lua.lua_getglobal(L, luaString("log"));
  lua.lua_setglobal(L, luaString("print"));
  for (const [name, helper] of Object.entries(context.helpers)) {
    lua.lua_pushjsfunction(L, (state) => {
      const args = [];
      for (let index = 1; index <= lua.lua_gettop(state); index += 1) {
        args.push(readValue(state, index) ?? undefined);
      }
      pushValue(state, helper(...args));
      return 1;
    });
    lua.lua_setglobal(L, luaString(name));
  }
};

const globalString = (L, name) => {
  lua.lua_getglobal(L, luaString(name));
  const value = lua.lua_type(L, -1) === lua.LUA_TSTRING ? lua.lua_tojsstring(L, -1) : null;
  lua.lua_pop(L, 1);
  return value;
};

const hasFunction = (L, name) => {
  lua.lua_getglobal(L, luaString(name));
  const present = lua.lua_type(L, -1) === lua.LUA_TFUNCTION;
  lua.lua_pop(L, 1);
  return present;
};

const callGlobal = (L, name, args) => {
  lua.lua_getglobal(L, luaString(name));
  for (const arg of args) pushValue(L, arg);
  if (lua.lua_pcall(L, args.length, 1, 0) !== lua.LUA_OK) throw new ScriptError(errorText(L));
  const value = readValue(L, -1);
  lua.lua_pop(L, 1);
  return value;
};

const scriptCache = new Map();

/** Every .lua file in the scripts folder, read once per change. */
export const listScripts = (dir) => {
  let files = [];
  try {
    files = readdirSync(dir).filter((file) => file.toLowerCase().endsWith(".lua")).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files.map((file) => {
    const full = path.join(dir, file);
    const stat = statSync(full);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = scriptCache.get(full);
    if (cached?.stamp === stamp) return cached.info;
    const source = readFileSync(full, "utf8");
    const info = { id: `script:${file}`, file, source, name: file.replace(/\.lua$/i, ""), description: "", author: null, error: null, standings: false };
    try {
      const L = newState(Math.random);
      run(L, source, file);
      info.name = globalString(L, "name") ?? info.name;
      info.description = globalString(L, "description") ?? "";
      info.author = globalString(L, "author");
      info.standings = hasFunction(L, "standings");
      if (!hasFunction(L, "generate")) info.error = "The script has no generate(round, pilots, channels, options) function.";
    } catch (error) {
      info.error = error.message;
    }
    scriptCache.set(full, { stamp, info });
    return info;
  });
};

/** Run a script's generate() for the next round and turn its races into a plan buildRound can seat. */
export const runScriptRound = (event, script, random = Math.random) => {
  if (script.error != null) return { error: `${script.file}: ${script.error}` };
  const stageId = event.activeStageId ?? event.stages?.[0]?.id;
  const context = scriptContext(event, { anchor: event.rounds.length, stageId });
  const max = event.maxPilotsPerRace;
  const pilots = event.pilots.map((pilot) => ({ id: pilot.id, name: pilot.name }));
  const roundTable = {
    number: event.rounds.length + 1,
    stage_index: context.stageRounds.length + 1,
    name: script.name,
    event_type: event.mode ?? "Race",
    game_type_name: event.gameTypeName ?? "",
  };
  const options = {
    max_pilots_per_race: max,
    target_laps: event.laps,
    pb_laps: event.pbLaps,
    race_count: Math.max(1, Math.ceil(pilots.length / Math.max(1, max))),
  };
  try {
    const L = newState(random);
    registerHelpers(L, context);
    run(L, script.source, script.file);
    pushValue(L, roundTable);
    lua.lua_setglobal(L, luaString("__webfpv_round"));
    lua.lua_getglobal(L, luaString("generate"));
    lua.lua_getglobal(L, luaString("__webfpv_round"));
    for (const arg of [pilots, context.helpers.get_channels(), options]) pushValue(L, arg);
    if (lua.lua_pcall(L, 4, 1, 0) !== lua.LUA_OK) throw new ScriptError(errorText(L));
    const result = readValue(L, -1);
    lua.lua_pop(L, 1);
    lua.lua_getglobal(L, luaString("__webfpv_round"));
    const edited = readValue(L, -1) ?? {};
    lua.lua_pop(L, 1);
    const name = typeof edited.name === "string" && edited.name.trim() !== "" ? edited.name.trim().slice(0, 60) : undefined;
    const eventType = EVENT_TYPES.includes(edited.event_type) ? edited.event_type : undefined;
    const notes = context.log.length > 0 ? `Script log: ${context.log.join(" · ")}` : null;
    if (result == null) {
      return { stop: "The script has no heats to draw yet. Finish the current heats, then generate again.", note: notes };
    }
    const known = new Set(event.pilots.map((pilot) => pilot.id));
    const seated = new Set();
    const races = [];
    for (const entry of arrayPart(result)) {
      const fields = Array.isArray(entry) ? {} : entry ?? {};
      const ids = (fields.pilots != null ? arrayPart(fields.pilots) : arrayPart(entry))
        .map((id) => (id == null ? null : String(id)))
        .filter((id) => id != null && known.has(id) && !seated.has(id));
      if (ids.length === 0) continue;
      ids.forEach((id) => seated.add(id));
      const bracket = BRACKETS.includes(fields.bracket) ? fields.bracket : "None";
      const targetLaps = Number.isInteger(fields.target_laps) && fields.target_laps > 0 ? fields.target_laps : undefined;
      races.push({ bracket, pilotIds: ids, targetLaps });
    }
    if (races.length === 0) return { stop: "The script returned no pilots to race.", note: notes };
    return { races, name, eventType, note: notes };
  } catch (error) {
    return { error: `${script.file}: ${error.message}` };
  }
};

/** A script's standings() card for its stage, or null when it has none or returns nil. */
export const runScriptStandings = (event, script, stageId) => {
  if (script.error != null || !script.standings) return null;
  const stageRoundIndexes = event.rounds.map((round, index) => (round.stageId === stageId ? index : -1)).filter((index) => index >= 0);
  if (stageRoundIndexes.length === 0) return null;
  const anchor = stageRoundIndexes.at(-1) + 1;
  const context = scriptContext(event, { anchor, stageId });
  const ids = new Set(
    stageRoundIndexes.flatMap((index) => event.rounds[index].races.flatMap((race) => race.slots.map((slot) => slot.pilotId))),
  );
  const pilots = event.pilots.filter((pilot) => ids.has(pilot.id)).map((pilot) => ({ id: pilot.id, name: pilot.name }));
  try {
    const L = newState(Math.random);
    registerHelpers(L, context);
    run(L, script.source, script.file);
    const result = callGlobal(L, "standings", [pilots, { target_laps: event.laps, pb_laps: event.pbLaps }]);
    if (result == null) return null;
    const rows = arrayPart(result.rows).map((row) => ({
      pilotId: row?.pilot_id ?? null,
      name: String(row?.name ?? ""),
      values: arrayPart(row?.values).map((value) => (value == null ? "" : String(value))),
    }));
    return { title: script.name, headings: arrayPart(result.headings).map(String), rows };
  } catch (error) {
    return { title: script.name, headings: ["Error"], rows: [{ pilotId: null, name: script.file, values: [error.message] }] };
  }
};

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ObsClient, heatTransitions, obsAuthentication } from "../public/obs.js";

const sha = (text) => createHash("sha256").update(text).digest("base64");

/** Behaves like obs-websocket 5: Hello with a challenge, checks Identify, answers requests. */
const fakeObs = ({ password, scenes }) => {
  const log = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      queueMicrotask(() => this.serverSend({ op: 0, d: { rpcVersion: 1, authentication: { salt: "pepper", challenge: "coin" } } }));
    }
    serverSend(packet) {
      this.onmessage?.({ data: JSON.stringify(packet) });
    }
    send(text) {
      const packet = JSON.parse(text);
      log.push(packet);
      if (packet.op === 1) {
        if (packet.d.authentication !== sha(sha(password + "pepper") + "coin")) {
          this.onclose?.({ code: 4009 });
          return;
        }
        this.serverSend({ op: 2, d: { negotiatedRpcVersion: 1 } });
      }
      if (packet.op === 6) {
        const { requestType, requestId, requestData } = packet.d;
        const ok = (responseData = {}) => this.serverSend({ op: 7, d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData } });
        if (requestType === "GetSceneList") ok({ scenes: scenes.map((sceneName, index) => ({ sceneName, sceneIndex: scenes.length - 1 - index })).reverse() });
        else if (requestType === "SetCurrentProgramScene" && !scenes.includes(requestData.sceneName)) {
          this.serverSend({ op: 7, d: { requestType, requestId, requestStatus: { result: false, code: 600, comment: "No source was found by the name of nope." } } });
        } else ok();
      }
    }
    close() {
      this.onclose?.({ code: 1000 });
    }
  }
  return { FakeSocket, log };
};

test("the OBS password answer matches the obs-websocket challenge", async () => {
  assert.equal(await obsAuthentication("secret", "pepper", "coin"), sha(sha("secretpepper") + "coin"));
});

test("the client identifies, lists scenes, switches scene, and reports failures", async () => {
  const { FakeSocket, log } = fakeObs({ password: "secret", scenes: ["Pilots", "Race", "Results"] });
  const statuses = [];
  const client = new ObsClient({ url: "ws://obs:4455", password: "secret", WebSocketImpl: FakeSocket, onStatus: (status) => statuses.push(status) });
  await client.connect();
  assert.deepEqual(await client.scenes(), ["Pilots", "Race", "Results"]);
  await client.request("SetCurrentProgramScene", { sceneName: "Race" });
  await client.request("StartRecord");
  await assert.rejects(client.request("SetCurrentProgramScene", { sceneName: "nope" }), /No source/);
  assert.deepEqual(log.filter((packet) => packet.op === 6).map((packet) => packet.d.requestType), ["GetSceneList", "SetCurrentProgramScene", "StartRecord", "SetCurrentProgramScene"]);
  assert.equal(statuses[0].connected, true);
});

test("a wrong OBS password is reported", async () => {
  const { FakeSocket } = fakeObs({ password: "secret", scenes: [] });
  const client = new ObsClient({ url: "ws://obs:4455", password: "wrong", WebSocketImpl: FakeSocket });
  await assert.rejects(client.connect(), /password/);
});

test("heat transitions report arming and finishing once", () => {
  const snapshot = (race) => ({ event: { rounds: [{ races: [race] }] } });
  const idle = { id: "r1", armedAt: null, endedAt: null };
  const armed = { ...idle, armedAt: "2026-10-11T00:00:00Z" };
  const ended = { ...armed, endedAt: "2026-10-11T00:01:00Z" };
  assert.deepEqual(heatTransitions(snapshot(idle), snapshot(armed)), [{ kind: "armed", raceId: "r1" }]);
  assert.deepEqual(heatTransitions(snapshot(armed), snapshot(ended)), [{ kind: "ended", raceId: "r1" }]);
  assert.deepEqual(heatTransitions(snapshot(ended), snapshot(ended)), []);
});

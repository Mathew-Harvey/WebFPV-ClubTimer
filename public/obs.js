/**
 * Minimal obs-websocket 5 client: Hello, Identify with the SHA-256 challenge,
 * then requests. OBS 28 and later ship this server on port 4455.
 */
const toBase64 = (bytes) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sha256Base64 = async (text) =>
  toBase64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** base64(sha256(base64(sha256(password + salt)) + challenge)), from the obs-websocket protocol. */
export const obsAuthentication = async (password, salt, challenge) =>
  sha256Base64((await sha256Base64(password + salt)) + challenge);

const OP = { Hello: 0, Identify: 1, Identified: 2, Request: 6, RequestResponse: 7 };

export class ObsClient {
  constructor({ url, password = "", WebSocketImpl = globalThis.WebSocket, onStatus = () => {} }) {
    this.url = url;
    this.password = password;
    this.WebSocketImpl = WebSocketImpl;
    this.onStatus = onStatus;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
        this.onStatus({ connected: false, message });
      };
      let socket;
      try {
        socket = new this.WebSocketImpl(this.url);
      } catch (error) {
        fail(`Cannot open ${this.url}: ${error.message}`);
        return;
      }
      this.socket = socket;
      let identified = false;
      const unreachable = `Cannot reach OBS at ${this.url}. Check that OBS is open and its WebSocket server is on.`;
      socket.onerror = () => {
        if (!identified) fail(unreachable);
      };
      socket.onclose = (event) => {
        this.ready = false;
        for (const { reject: stop } of this.pending.values()) stop(new Error("OBS closed the connection."));
        this.pending.clear();
        if (event?.code === 4009) fail("OBS rejected the password.");
        else if (identified) this.onStatus({ connected: false, message: "OBS disconnected." });
        else fail(unreachable);
      };
      socket.onmessage = async (message) => {
        const packet = JSON.parse(typeof message.data === "string" ? message.data : String(message.data));
        if (packet.op === OP.Hello) {
          const identify = { rpcVersion: 1, eventSubscriptions: 0 };
          const auth = packet.d?.authentication;
          if (auth != null) identify.authentication = await obsAuthentication(this.password, auth.salt, auth.challenge);
          socket.send(JSON.stringify({ op: OP.Identify, d: identify }));
        } else if (packet.op === OP.Identified) {
          this.ready = true;
          identified = true;
          settled = true;
          this.onStatus({ connected: true, message: "Connected to OBS." });
          resolve();
        } else if (packet.op === OP.RequestResponse) {
          const waiting = this.pending.get(packet.d.requestId);
          if (waiting == null) return;
          this.pending.delete(packet.d.requestId);
          if (packet.d.requestStatus?.result) waiting.resolve(packet.d.responseData ?? {});
          else waiting.reject(new Error(packet.d.requestStatus?.comment ?? `${packet.d.requestType} failed.`));
        }
      };
    });
  }

  request(requestType, requestData = {}) {
    if (!this.ready || this.socket == null) return Promise.reject(new Error("OBS is not connected."));
    const requestId = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.socket.send(JSON.stringify({ op: OP.Request, d: { requestType, requestId, requestData } }));
    });
  }

  async scenes() {
    const data = await this.request("GetSceneList");
    return (data.scenes ?? []).map((scene) => scene.sceneName).reverse();
  }

  close() {
    this.ready = false;
    this.socket?.close();
  }
}

/** Heat changes between two desk snapshots, in the order OBS should hear about them. */
export const heatTransitions = (before, after) => {
  if (before == null || after == null) return [];
  const previous = new Map(before.event.rounds.flatMap((round) => round.races).map((race) => [race.id, race]));
  const out = [];
  for (const race of after.event.rounds.flatMap((round) => round.races)) {
    const old = previous.get(race.id);
    if (old == null) continue;
    if (old.armedAt == null && race.armedAt != null) out.push({ kind: "armed", raceId: race.id });
    if (old.endedAt == null && race.endedAt != null) out.push({ kind: "ended", raceId: race.id });
  }
  return out;
};

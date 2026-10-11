import { ObsClient } from "./obs.js";

const STORE = "webfpv-obs";
const TRIGGERS = [
  ["armed", "When a heat is armed"],
  ["horn", "When the start horn sounds"],
  ["ended", "When a heat ends"],
];

const load = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? "{}");
  } catch {
    return {};
  }
};

let settings = { url: "ws://127.0.0.1:4455", scenes: {}, record: false, remember: false, password: "", ...load() };
let client = null;
let statusLine = null;
let sceneSelects = new Map();
let scenes = [];

const save = () => {
  const kept = { ...settings };
  if (!kept.remember) delete kept.password;
  localStorage.setItem(STORE, JSON.stringify(kept));
};

const setStatus = (text, isError = false) => {
  if (statusLine == null) return;
  statusLine.textContent = text;
  statusLine.classList.toggle("error", isError);
};

const fillScenes = () => {
  for (const [trigger, select] of sceneSelects) {
    select.replaceChildren(new Option("Don’t change the scene", ""));
    for (const name of scenes) select.append(new Option(name, name));
    select.value = scenes.includes(settings.scenes[trigger]) ? settings.scenes[trigger] : "";
    select.disabled = client?.ready !== true;
  }
};

/** Tell OBS about a heat change. Failures show in the panel and never block the desk. */
export const obsHeatEvent = async (kind) => {
  if (client?.ready !== true) return;
  try {
    const scene = settings.scenes[kind];
    if (scene) await client.request("SetCurrentProgramScene", { sceneName: scene });
    if (settings.record && kind === "horn") await client.request("StartRecord");
    if (settings.record && kind === "ended") await client.request("StopRecord");
    setStatus(`Connected. Last cue: ${TRIGGERS.find(([id]) => id === kind)?.[1].toLowerCase() ?? kind}.`);
  } catch (error) {
    setStatus(`OBS: ${error.message}`, true);
  }
};

export const mountObsPanel = (container) => {
  const field = (label, input) => {
    const wrap = document.createElement("label");
    wrap.append(label, input);
    return wrap;
  };
  const url = Object.assign(document.createElement("input"), { value: settings.url, placeholder: "ws://127.0.0.1:4455" });
  const password = Object.assign(document.createElement("input"), { type: "password", value: settings.password ?? "", autocomplete: "off" });
  const remember = Object.assign(document.createElement("input"), { type: "checkbox", checked: settings.remember });
  const record = Object.assign(document.createElement("input"), { type: "checkbox", checked: settings.record });
  const connect = Object.assign(document.createElement("button"), { type: "button", className: "secondary", textContent: "Connect to OBS" });
  statusLine = Object.assign(document.createElement("p"), { className: "help", textContent: "Not connected. In OBS, turn on Tools › WebSocket Server Settings." });
  const rememberLabel = document.createElement("label");
  rememberLabel.className = "check";
  rememberLabel.append(remember, " Remember the password on this computer");
  const recordLabel = document.createElement("label");
  recordLabel.className = "check";
  recordLabel.append(record, " Record each heat from the horn to the finish");
  sceneSelects = new Map(TRIGGERS.map(([id]) => [id, document.createElement("select")]));
  container.append(
    field("OBS WebSocket address", url),
    field("Password", password),
    rememberLabel,
    connect,
    statusLine,
    ...TRIGGERS.map(([id, label]) => field(label, sceneSelects.get(id))),
    recordLabel,
  );
  fillScenes();

  const persist = () => {
    settings = { ...settings, url: url.value.trim(), password: password.value, remember: remember.checked, record: record.checked };
    save();
  };
  for (const input of [url, password, remember, record]) input.addEventListener("change", persist);
  for (const [trigger, select] of sceneSelects) {
    select.addEventListener("change", () => {
      settings.scenes = { ...settings.scenes, [trigger]: select.value };
      save();
    });
  }
  connect.addEventListener("click", async () => {
    persist();
    if (client?.ready) {
      client.close();
      client = null;
      connect.textContent = "Connect to OBS";
      setStatus("Disconnected.");
      fillScenes();
      return;
    }
    setStatus("Connecting…");
    client = new ObsClient({
      url: settings.url,
      password: password.value,
      onStatus: ({ connected, message }) => {
        if (!connected) {
          connect.textContent = "Connect to OBS";
          setStatus(message, true);
          fillScenes();
        }
      },
    });
    try {
      await client.connect();
      scenes = await client.scenes();
      connect.textContent = "Disconnect";
      setStatus(`Connected. ${scenes.length} scenes found.`);
    } catch (error) {
      setStatus(error.message, true);
    }
    fillScenes();
  });
};

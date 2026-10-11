import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createEvent, normalizeEvent } from "./model.mjs";

export const loadEvent = (file) => {
  try {
    return normalizeEvent(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const event = createEvent();
    saveEvent(file, event);
    return event;
  }
};

export const saveEvent = (file, event) => {
  event.updatedAt = new Date().toISOString();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`);
};

export const chargedSeconds = (race, fromMs, toMs) => {
  let cut = 0;
  for (const pause of race.pauses ?? []) {
    const start = Date.parse(pause.start);
    const end = pause.end == null ? toMs : Date.parse(pause.end);
    const left = Math.max(fromMs, start);
    const right = Math.min(toMs, end);
    if (right > left) cut += right - left;
  }
  return Math.max(0, (toMs - fromMs - cut) / 1000);
};

export const clockSeconds = (race, now = Date.now()) => {
  if (race.startedAt == null) return 0;
  const start = Date.parse(race.startedAt);
  const to = race.endedAt == null ? now : Date.parse(race.endedAt);
  return chargedSeconds(race, start, to);
};

export const formatSeconds = (value) => {
  if (value == null || Number.isNaN(value)) return "—";
  const negative = value < 0;
  const abs = Math.abs(value);
  const minutes = Math.floor(abs / 60);
  const seconds = (abs - minutes * 60).toFixed(3).padStart(6, "0");
  const text = `${minutes}:${seconds}`;
  return negative ? `-${text}` : text;
};

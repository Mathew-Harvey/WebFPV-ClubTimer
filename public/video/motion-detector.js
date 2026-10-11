// Video static detector and automatic crash-out, from FPVTrackside 2.78 UI.dll:
//   UI.Video.MotionDetector, UI.Video.MotionState, UI.AutoCrashOut
// A live FPV feed is colourful (saturation) and changes from frame to frame (motion). A crashed
// quad still sends a colourful picture, but it stops changing; that is what triggers a crash-out.

export const MOTION_STATES = Object.freeze({
  Unknown: "Unknown",
  ActiveMotion: "ActiveMotion",
  ActiveNoMotion: "ActiveNoMotion",
  InactiveMotion: "InactiveMotion",
  InactiveNoMotion: "InactiveNoMotion",
});

/** MotionDetector hysteresis: leave the low state above the high value, enter it at or below the low one. */
export const MOTION_THRESHOLDS = Object.freeze({ saturationLow: 4, saturationHigh: 20, diffLow: 2, diffHigh: 8 });

/** AutoCrashOut static timings. */
export const CRASH_TIMING = Object.freeze({
  queueLengthMs: 4000,
  historyLengthMs: 30000,
  historySampleRateMs: 100,
  crashDurationMs: 2000,
  recoverDurationMs: 3000,
});

/** Mean of max(R,G,B) - min(R,G,B) over the frame. */
export const frameSaturation = (rgba) => {
  const pixels = rgba.length >> 2;
  if (pixels === 0) return 0;
  let total = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    const r = rgba[p];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    total += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return total / pixels;
};

/** Mean absolute per-channel difference between two frames of the same size, else 0. */
export const frameDifference = (rgba, previous) => {
  if (previous == null || previous.length !== rgba.length || rgba.length === 0) return 0;
  let total = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    total += Math.abs(rgba[p] - previous[p]) + Math.abs(rgba[p + 1] - previous[p + 1]) + Math.abs(rgba[p + 2] - previous[p + 2]);
  }
  return total / ((rgba.length >> 2) * 3);
};

/** UI.Video.MotionDetector. Times are epoch milliseconds. */
export class MotionDetector {
  constructor(queueLengthMs = CRASH_TIMING.queueLengthMs) {
    this.queueLengthMs = queueLengthMs;
    this.clear();
  }

  clear() {
    this.frames = [];
    this.inLowState = false;
    this.diffInLowState = false;
    this.previousFrame = null;
  }

  addFrame(rgba, now = Date.now()) {
    const saturation = frameSaturation(rgba);
    const diff = frameDifference(rgba, this.previousFrame);
    this.previousFrame = rgba.slice();
    this.frames.push({ saturation, diff, time: now });
    while (this.frames.length > 0 && now - this.frames[0].time > this.queueLengthMs) this.frames.shift();
  }

  /** True once the queue reaches back at least 90% of its length. */
  hasMotionData(now = Date.now()) {
    const oldest = this.frames[0];
    return oldest != null && (now - oldest.time) / 1000 > (this.queueLengthMs / 1000) * 0.9;
  }

  /** Returns { state, saturation, diff } averaged over the queue. */
  detectMotion(now = Date.now()) {
    if (!this.hasMotionData(now)) return { state: MOTION_STATES.Unknown, saturation: 0, diff: 0 };
    const saturation = this.frames.reduce((sum, frame) => sum + frame.saturation, 0) / this.frames.length;
    const diff = this.frames.reduce((sum, frame) => sum + frame.diff, 0) / this.frames.length;
    const { saturationLow, saturationHigh, diffLow, diffHigh } = MOTION_THRESHOLDS;
    let active;
    if (this.inLowState) {
      active = saturation > saturationHigh;
      if (active) this.inLowState = false;
    } else {
      active = saturation > saturationLow;
      if (!active) this.inLowState = true;
    }
    let motion;
    if (this.diffInLowState) {
      motion = diff > diffHigh;
      if (motion) this.diffInLowState = false;
    } else {
      motion = diff > diffLow;
      if (!motion) this.diffInLowState = true;
    }
    const state = active
      ? motion ? MOTION_STATES.ActiveMotion : MOTION_STATES.ActiveNoMotion
      : motion ? MOTION_STATES.InactiveMotion : MOTION_STATES.InactiveNoMotion;
    return { state, saturation, diff };
  }
}

const isMotion = (state) => state === MOTION_STATES.ActiveMotion || state === MOTION_STATES.InactiveMotion;
const isNoMotion = (state) => state === MOTION_STATES.ActiveNoMotion || state === MOTION_STATES.InactiveNoMotion;

/**
 * UI.AutoCrashOut. Feed frames with addFrame, call sample() regularly and update() from the race
 * loop. update returns the crash changes to apply: [{ key, crashed }].
 */
export class AutoCrashOut {
  constructor({ startDelayMs = 0, timing = CRASH_TIMING } = {}) {
    this.startDelayMs = startDelayMs;
    this.timing = timing;
    this.detectors = new Map();
    this.current = new Map();
    this.history = new Map();
    this.nextHistorySample = 0;
    this.waitTill = -Infinity;
    this.needsClear = false;
  }

  /** RaceManager_OnRaceStart: no crash-outs until the start delay has passed. */
  raceStarted(now = Date.now()) {
    this.waitTill = now + this.startDelayMs;
    this.needsClear = true;
  }

  raceEnded() {
    this.waitTill = Infinity;
    this.needsClear = true;
  }

  #clearIfNeeded(now) {
    if (!this.needsClear) return;
    this.needsClear = false;
    for (const detector of this.detectors.values()) detector.clear();
    this.current.clear();
    this.history.clear();
    this.nextHistorySample = now + this.timing.historySampleRateMs;
  }

  /** Process: one new frame for a channel. Returns the motion reading. */
  addFrame(key, rgba, now = Date.now()) {
    this.#clearIfNeeded(now);
    let detector = this.detectors.get(key);
    if (detector == null) {
      detector = new MotionDetector(this.timing.queueLengthMs);
      this.detectors.set(key, detector);
    }
    detector.addFrame(rgba, now);
    const reading = detector.detectMotion(now);
    if (reading.state !== MOTION_STATES.Unknown) this.current.set(key, reading.state);
    return reading;
  }

  /** Process: record each channel's state every historySampleRateMs, keeping historyLengthMs. */
  sample(now = Date.now()) {
    if (now < this.nextHistorySample) return;
    this.nextHistorySample = now + this.timing.historySampleRateMs;
    const cutoff = now - this.timing.historyLengthMs;
    for (const [key, state] of this.current) {
      let queue = this.history.get(key);
      if (queue == null) {
        queue = [];
        this.history.set(key, queue);
      }
      queue.push({ time: now, state });
      while (queue.length > 0 && queue[0].time < cutoff) queue.shift();
    }
  }

  stateOf(key) {
    return this.current.get(key) ?? MOTION_STATES.Unknown;
  }

  /** GetMotionStatesFor: nothing until the history reaches back the whole duration. */
  statesFor(key, durationMs, now = Date.now()) {
    const queue = this.history.get(key);
    const cutoff = now - durationMs;
    if (queue == null || queue.length === 0 || queue[0].time > cutoff) return [];
    return queue.filter((entry) => entry.time >= cutoff).map((entry) => entry.state);
  }

  hasMotionFor(key, durationMs, now) {
    const states = this.statesFor(key, durationMs, now);
    return states.length > 0 && states.every(isMotion);
  }

  hasNoMotionFor(key, durationMs, now) {
    const states = this.statesFor(key, durationMs, now);
    return states.length > 0 && states.every(isNoMotion);
  }

  /** IsActive: Unknown counts as active, so a missing reading never blocks a recovery. */
  isActive(key) {
    const state = this.stateOf(key);
    return state === MOTION_STATES.ActiveMotion || state === MOTION_STATES.ActiveNoMotion || state === MOTION_STATES.Unknown;
  }

  /**
   * AutoCrashOut.Update for a running race. channels: [{ key, crashedOut }].
   * A crashed channel recovers once it is active with motion for recoverDurationMs; any other
   * channel is crashed out after crashDurationMs without motion, once the start delay is over.
   */
  update(channels, now = Date.now()) {
    const waiting = now <= this.waitTill;
    const changes = [];
    for (const { key, crashedOut } of channels) {
      if (crashedOut) {
        if (this.isActive(key) && this.hasMotionFor(key, this.timing.recoverDurationMs, now)) changes.push({ key, crashed: false });
      } else if (!waiting && this.hasNoMotionFor(key, this.timing.crashDurationMs, now)) {
        changes.push({ key, crashed: true });
      }
    }
    return changes;
  }
}

// Camera lap timing with ArUco markers, from FPVTrackside 2.78:
//   Timing.Aruco.ArucoTimingSettings / ArucoTimingSystem (Timing.dll)
//   UI.Video.ArucoTimingManager (UI.dll)
// A channel is "in the gate" while enough qualifying markers are visible. When they stay gone for
// the flicker window, one detection is emitted, timed at the moment they were last seen.

/** ArucoTimingManager.FrameWidth/FrameHeight: every pilot feed is scaled to this before detection. */
export const DETECTION_FRAME = Object.freeze({ width: 480, height: 360 });

/** ArucoFrameOverlay.OverlayHoldMs: boxes stay on screen this long after the last sighting. */
export const OVERLAY_HOLD_MS = 150;

/** ArucoTimingSettings constructor defaults. */
export const ARUCO_DEFAULTS = Object.freeze({
  markerIds: "0",
  detectMode: "Hybrid",
  markerThreshold: 2,
  flickerLengthMs: 150,
  minMarkerPercent: 0.1,
  errorCorrectionRate: 0.6,
  hybridDistanceThreshold: 20,
  useMultiThreadDetection: true,
  ignoreLostSignal: false,
  lostSignalThreshold: 0.4,
  showMarkerBox: true,
  showMarkerId: true,
  showMarkerSizePercent: true,
  showFps: false,
  showSignalRatio: false,
  characterFlipVertical: true,
  role: "Primary",
});

const INT32 = /^[+-]?\d+$/;

/** ArucoTimingSettings.EffectiveMarkerIds: comma list, entries that are not integers are skipped. */
export const effectiveMarkerIds = (markerIds) => {
  if (typeof markerIds !== "string" || markerIds.trim() === "") return [];
  const ids = [];
  for (const part of markerIds.split(",")) {
    const text = part.trim();
    if (!INT32.test(text)) continue;
    const value = Number(text);
    if (value >= -2147483648 && value <= 2147483647) ids.push(value);
  }
  return ids;
};

export const settingsLabel = (settings) => {
  const ids = settings?.markerIds;
  return `ArUco (Marker ${typeof ids === "string" && ids.trim() !== "" ? ids : "-"})`;
};

const newChannelState = () => ({ inGate: false, flickerEndTime: null, lastPeak: 0, lastDetectionTime: -Infinity });

/** Timing.Aruco.ArucoTimingSystem. Times are epoch milliseconds. */
export class ArucoTimingSystem {
  constructor(settings = {}, onDetection = null) {
    this.settings = { ...ARUCO_DEFAULTS, ...settings };
    this.onDetection = onDetection;
    this.detecting = false;
    this.stateByFrequency = new Map();
  }

  get name() {
    return `ArUco ${this.settings.markerIds ?? "-"}`;
  }

  get maxPilots() {
    return 32;
  }

  setListeningFrequencies(frequencies) {
    this.stateByFrequency.clear();
    for (const frequency of frequencies) {
      if (!this.stateByFrequency.has(frequency)) this.stateByFrequency.set(frequency, newChannelState());
    }
    return true;
  }

  startDetection() {
    for (const state of this.stateByFrequency.values()) {
      state.inGate = false;
      state.flickerEndTime = null;
      state.lastPeak = 0;
      state.lastDetectionTime = -Infinity;
    }
    this.detecting = true;
    return true;
  }

  endDetection() {
    this.detecting = false;
    return true;
  }

  /**
   * ArucoTimingSystem.ReportMarkerCount. Returns the detection it emitted, if any, as
   * { frequency, time, peak }.
   */
  reportMarkerCount(frequency, count, peak, captureTime, markerThreshold, flickerLengthMs) {
    if (!this.detecting || this.settings == null) return null;
    const state = this.stateByFrequency.get(frequency);
    if (state == null) return null;
    if (count >= markerThreshold) {
      state.inGate = true;
      state.lastPeak = peak;
      state.flickerEndTime = null;
      return null;
    }
    if (!state.inGate) return null;
    if (state.flickerEndTime == null) state.flickerEndTime = captureTime + flickerLengthMs;
    if (captureTime < state.flickerEndTime) return null;
    const detectionTime = captureTime - flickerLengthMs;
    state.inGate = false;
    state.flickerEndTime = null;
    if (detectionTime <= state.lastDetectionTime) return null;
    state.lastDetectionTime = detectionTime;
    const detection = { frequency, time: detectionTime, peak: state.lastPeak, system: this };
    this.onDetection?.(detection);
    return detection;
  }
}

/** ArucoTimingManager.EnforceSinglePrimary: extra Primary systems are demoted to Split. */
export const enforceSinglePrimary = (systems, log = () => {}) => {
  let seen = false;
  for (const system of systems) {
    if (system.settings == null || system.settings.role !== "Primary") continue;
    if (!seen) {
      seen = true;
      continue;
    }
    log(`only one Primary is allowed; demoting Marker(s) ${system.settings.markerIds ?? "-"} to Split.`);
    system.settings.role = "Split";
  }
};

/** Detection-wide settings come from the Primary system, else the first configured one. */
export const sharedSettings = (systems) =>
  systems.find((system) => system.settings?.role === "Primary")?.settings ??
  systems.find((system) => system.settings != null)?.settings ??
  null;

/**
 * Per-frame marker count for one system: detections with one of its ids whose area is at least
 * minMarkerPercent of the detection frame. peak is the largest qualifying area, truncated.
 */
export const countMarkers = (detections, ids, minMarkerPercent, frameArea = DETECTION_FRAME.width * DETECTION_FRAME.height) => {
  const minArea = frameArea * (minMarkerPercent / 100);
  let count = 0;
  let peak = 0;
  for (const detection of detections) {
    if (!ids.includes(detection.id) || detection.areaPx < minArea) continue;
    count += 1;
    if (detection.areaPx > peak) peak = detection.areaPx;
  }
  return { count, peak: Math.trunc(peak) };
};

/**
 * Feed one channel's detections to every system. Thresholds come from the shared (Primary)
 * settings; marker ids stay per system so a Split system can watch its own marker.
 */
export const reportChannelDetections = (systems, frequency, detections, captureTime, shared = sharedSettings(systems), frameArea) => {
  const emitted = [];
  for (const system of systems) {
    const own = system.settings;
    if (own == null) continue;
    const effective = shared ?? own;
    const { count, peak } = countMarkers(detections, effectiveMarkerIds(own.markerIds), effective.minMarkerPercent, frameArea);
    const detection = system.reportMarkerCount(frequency, count, peak, captureTime, effective.markerThreshold, effective.flickerLengthMs);
    if (detection != null) emitted.push(detection);
  }
  return emitted;
};

/** Detections-per-second counter, refreshed about once a second like ArucoFrameOverlay.DetectionFps. */
export class FpsCounter {
  constructor(now = Date.now()) {
    this.frames = 0;
    this.since = now;
    this.fps = 0;
  }

  tick(now = Date.now()) {
    this.frames += 1;
    const elapsed = now - this.since;
    if (elapsed >= 1000) {
      this.fps = (this.frames * 1000) / elapsed;
      this.frames = 0;
      this.since = now;
    }
    return this.fps;
  }
}

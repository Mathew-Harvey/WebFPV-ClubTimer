// Module worker that runs one channel's detection off the main thread, the browser stand-in for
// ArucoTimingManager's Parallel.For over channels. One ArucoMarkerDetector per channel key.
//
// in:  { type: "calibration", calibration | null }
//      { type: "detect", key, frameId, width, height, pixels (RGBA ArrayBuffer), mode, ecRate,
//        hybridDistPx, computeRatio, ignoreLostSignal, lostSignalThreshold }
// out: { type: "detections", key, frameId, detections, signalRatio, blanked, ms }
import { ArucoMarkerDetector, signalRatio } from "./aruco-detector.js";

const detectors = new Map();
let calibration = null;

const detectorFor = (key, width, height) => {
  let entry = detectors.get(key);
  if (entry == null || entry.width !== width || entry.height !== height) {
    const detector = new ArucoMarkerDetector();
    detector.applyCalibration(calibration, width, height);
    entry = { detector, width, height };
    detectors.set(key, entry);
  }
  return entry.detector;
};

self.onmessage = ({ data }) => {
  if (data.type === "calibration") {
    calibration = data.calibration ?? null;
    for (const entry of detectors.values()) entry.detector.applyCalibration(calibration, entry.width, entry.height);
    return;
  }
  if (data.type !== "detect") return;
  const started = performance.now();
  const pixels = new Uint8ClampedArray(data.pixels);
  let ratio = Number.NaN;
  let blanked = false;
  if (data.computeRatio) {
    ratio = signalRatio(pixels, data.width, data.height);
    if (data.ignoreLostSignal && ratio < data.lostSignalThreshold) {
      pixels.fill(0);
      blanked = true;
    }
  }
  const detections = detectorFor(data.key, data.width, data.height).detect(
    pixels,
    data.width,
    data.height,
    data.mode,
    data.ecRate,
    data.hybridDistPx,
  );
  self.postMessage({
    type: "detections",
    key: data.key,
    frameId: data.frameId,
    detections,
    signalRatio: ratio,
    blanked,
    ms: performance.now() - started,
  });
};

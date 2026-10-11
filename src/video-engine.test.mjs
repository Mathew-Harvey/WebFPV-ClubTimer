import assert from "node:assert/strict";
import test from "node:test";
import { DICT_4X4_50, codeToBits, rotateBits } from "../public/video/aruco-dictionary.js";
import {
  ArucoMarkerDetector,
  contourArea,
  detectMarkers,
  rgbaToGray,
  signalRatio,
} from "../public/video/aruco-detector.js";
import {
  buildUndistortMaps,
  distortNormalized,
  parseCalibration,
  undistortNormalized,
} from "../public/video/calibration.js";
import {
  ARUCO_DEFAULTS,
  ArucoTimingSystem,
  DETECTION_FRAME,
  countMarkers,
  effectiveMarkerIds,
  enforceSinglePrimary,
  reportChannelDetections,
  settingsLabel,
  sharedSettings,
} from "../public/video/aruco-timing.js";
import { AutoCrashOut, MOTION_STATES, MotionDetector, frameDifference, frameSaturation } from "../public/video/motion-detector.js";
import { HeldDetections, markerLabel } from "../public/video/overlay.js";
import { blankFrame, markerSvg, paintMarker } from "../public/video/marker-sheet.js";

const W = DETECTION_FRAME.width;
const H = DETECTION_FRAME.height;

const square = (cx, cy, half, degrees = 0) => {
  const a = (degrees * Math.PI) / 180;
  return [[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, y]) => ({
    x: cx + x * Math.cos(a) - y * Math.sin(a),
    y: cy + x * Math.sin(a) + y * Math.cos(a),
  }));
};

const frameWith = (markers) => {
  const frame = blankFrame(W, H);
  for (const { id, corners } of markers) paintMarker(frame, W, H, id, corners);
  return frame;
};

const seeded = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

test("the DICT_4X4_50 table matches the bytes in the shipped OpenCV build", () => {
  assert.equal(DICT_4X4_50.size, 50);
  assert.deepEqual(DICT_4X4_50.bits(0), codeToBits((181 << 8) | 50, 4));
  for (let id = 0; id < DICT_4X4_50.size; id += 1) {
    let bits = DICT_4X4_50.bits(id);
    for (let rotation = 0; rotation < 4; rotation += 1) {
      assert.deepEqual(DICT_4X4_50.identify(bits, 0.6), { id, rotation });
      bits = rotateBits(bits, 4);
    }
  }
});

test("error correction follows maxCorrectionBits times the rate", () => {
  const bits = DICT_4X4_50.bits(5);
  bits[6] ^= 1;
  assert.equal(DICT_4X4_50.identify(bits, 0.6), null);
  assert.equal(DICT_4X4_50.identify(bits, 1).id, 5);
});

test("markers are found with corner 0 at the printed top-left, in any rotation", () => {
  const placed = [
    { id: 0, corners: square(90, 90, 50) },
    { id: 7, corners: square(250, 100, 45, 90) },
    { id: 23, corners: square(390, 110, 40, 200) },
    { id: 49, corners: [{ x: 60, y: 220 }, { x: 170, y: 240 }, { x: 160, y: 330 }, { x: 70, y: 340 }] },
    { id: 12, corners: square(300, 260, 30, 33) },
  ];
  const found = detectMarkers(rgbaToGray(frameWith(placed), W, H), W, H);
  assert.deepEqual(found.map((marker) => marker.id).sort((a, b) => a - b), [0, 7, 12, 23, 49]);
  for (const marker of found) {
    const expected = placed.find((item) => item.id === marker.id).corners;
    marker.corners.forEach((corner, index) => {
      assert.ok(Math.hypot(corner.x - expected[index].x, corner.y - expected[index].y) <= 1.5, `id ${marker.id} corner ${index}`);
    });
  }
});

test("plain and noisy frames produce no markers", () => {
  assert.deepEqual(detectMarkers(rgbaToGray(blankFrame(W, H), W, H), W, H), []);
  const random = seeded(7);
  const noise = blankFrame(W, H);
  for (let p = 0; p < noise.length; p += 4) noise[p] = noise[p + 1] = noise[p + 2] = Math.floor(random() * 256);
  assert.deepEqual(detectMarkers(rgbaToGray(noise, W, H), W, H), []);
});

test("the detector keeps ids 0-49 and reports shoelace areas", () => {
  const corners = square(240, 180, 60, 10);
  const [detection] = new ArucoMarkerDetector().detect(frameWith([{ id: 31, corners }]), W, H, "Original", 0.6, 20);
  assert.equal(detection.id, 31);
  assert.equal(detection.source, "Original");
  assert.ok(Math.abs(detection.areaPx - contourArea(corners)) / contourArea(corners) < 0.05);
  assert.equal(contourArea([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]), 100);
});

test("calibration parsing keeps TryLoad's reasons and defaults", () => {
  assert.equal(parseCalibration("{").error.startsWith("SyntaxError"), true);
  assert.equal(parseCalibration({}).error, "mtx missing or not 3x3");
  assert.equal(parseCalibration({ mtx: [[1, 0, 0], [0, 1], [0, 0, 1]] }).error, "mtx row 1 not length 3");
  assert.equal(parseCalibration({ mtx: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }).error, "dist missing");
  const nested = parseCalibration({ mtx: [[500, 0, 480], [0, 500, 360], [0, 0, 1]], dist: [[-0.2, 0.05, 0, 0, 0]] });
  assert.deepEqual(nested.calibration.dist, [-0.2, 0.05, 0, 0, 0]);
  assert.equal(nested.calibration.referenceWidth, 960);
  assert.equal(nested.calibration.referenceHeight, 720);
  const flat = parseCalibration({ mtx: [[500, 0, 320], [0, 500, 240], [0, 0, 1]], dist: [0.1, 0, 0, 0, 0], resolution: [480, 640] });
  assert.equal(flat.calibration.referenceWidth, 640);
  assert.equal(flat.calibration.referenceHeight, 480);
});

test("the distortion model round-trips and zero distortion gives identity maps", () => {
  const dist = [-0.28, 0.07, 0.001, -0.0005, 0];
  const point = distortNormalized(0.3, -0.2, dist);
  const back = undistortNormalized(point.x, point.y, dist);
  assert.ok(Math.abs(back.x - 0.3) < 1e-3 && Math.abs(back.y + 0.2) < 1e-3);
  const { calibration } = parseCalibration({ mtx: [[600, 0, 479.5], [0, 600, 359.5], [0, 0, 1]], dist: [0, 0, 0, 0, 0] });
  const { mapX, mapY } = buildUndistortMaps(calibration, W, H);
  for (const [x, y] of [[0, 0], [100, 50], [479, 359]]) {
    assert.ok(Math.abs(mapX[y * W + x] - x) < 1e-3 && Math.abs(mapY[y * W + x] - y) < 1e-3);
  }
});

test("Hybrid merges both passes and Corrected needs maps that fit the frame", () => {
  const { calibration } = parseCalibration({ mtx: [[600, 0, 479.5], [0, 600, 359.5], [0, 0, 1]], dist: [-0.05, 0, 0, 0, 0] });
  const frame = frameWith([{ id: 3, corners: square(240, 180, 50) }]);
  const detector = new ArucoMarkerDetector();
  assert.equal(detector.hasCalibration, false);
  assert.deepEqual(detector.detect(frame, W, H, "Corrected", 0.6, 20), []);
  detector.applyCalibration(calibration, W, H);
  assert.equal(detector.hasCalibration, true);
  const hybrid = detector.detect(frame, W, H, "Hybrid", 0.6, 20);
  assert.deepEqual(hybrid.map((d) => [d.id, d.source]), [[3, "Both"]]);
  const corrected = detector.detect(frame, W, H, "Corrected", 0.6, 20);
  assert.deepEqual(corrected.map((d) => [d.id, d.source]), [[3, "Corrected"]]);
  detector.applyCalibration(calibration, 320, 240);
  assert.deepEqual(detector.detect(frame, W, H, "Corrected", 0.6, 20), []);
});

test("the lost-signal ratio separates snow from a picture", () => {
  const random = seeded(3);
  const snow = blankFrame(W, H);
  for (let p = 0; p < snow.length; p += 4) snow[p] = snow[p + 1] = snow[p + 2] = Math.floor(random() * 256);
  const picture = blankFrame(W, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 4;
      const value = x < W / 2 ? 40 + (y / H) * 60 : 200 - (x / W) * 50;
      picture[p] = picture[p + 1] = picture[p + 2] = value;
    }
  }
  assert.ok(signalRatio(snow, W, H) < ARUCO_DEFAULTS.lostSignalThreshold);
  assert.ok(signalRatio(picture, W, H) > 0.8);
  assert.equal(signalRatio(blankFrame(W, H), W, H), 0);
  assert.equal(signalRatio(new Uint8ClampedArray(10), W, H), 1);
});

test("settings keep FPVTrackside's defaults and marker id parsing", () => {
  assert.deepEqual(
    [ARUCO_DEFAULTS.markerIds, ARUCO_DEFAULTS.detectMode, ARUCO_DEFAULTS.markerThreshold, ARUCO_DEFAULTS.flickerLengthMs],
    ["0", "Hybrid", 2, 150],
  );
  assert.deepEqual(
    [ARUCO_DEFAULTS.minMarkerPercent, ARUCO_DEFAULTS.errorCorrectionRate, ARUCO_DEFAULTS.hybridDistanceThreshold, ARUCO_DEFAULTS.lostSignalThreshold],
    [0.1, 0.6, 20, 0.4],
  );
  assert.deepEqual(effectiveMarkerIds(" 1, 2 ,x, 3,,+4,-1"), [1, 2, 3, 4, -1]);
  assert.deepEqual(effectiveMarkerIds(""), []);
  assert.equal(settingsLabel({ markerIds: "0,5" }), "ArUco (Marker 0,5)");
  assert.equal(settingsLabel({ markerIds: " " }), "ArUco (Marker -)");
});

test("a pass is timed when the markers have been gone for the flicker window", () => {
  const detections = [];
  const system = new ArucoTimingSystem({}, (detection) => detections.push(detection));
  system.setListeningFrequencies([5658]);
  assert.equal(system.reportMarkerCount(5658, 2, 900, 1000, 2, 150), null);
  system.startDetection();
  system.reportMarkerCount(5658, 2, 900, 1000, 2, 150);
  system.reportMarkerCount(5658, 3, 1200, 1033, 2, 150);
  system.reportMarkerCount(5658, 1, 0, 1066, 2, 150);
  system.reportMarkerCount(5658, 2, 1100, 1099, 2, 150);
  for (const time of [1132, 1165, 1198, 1231, 1264]) assert.equal(system.reportMarkerCount(5658, 0, 0, time, 2, 150), null);
  const pass = system.reportMarkerCount(5658, 0, 0, 1297, 2, 150);
  assert.deepEqual([pass.frequency, pass.time, pass.peak], [5658, 1147, 1100]);
  assert.equal(detections.length, 1);
  assert.equal(system.reportMarkerCount(5800, 5, 1, 2000, 2, 150), null);
  system.endDetection();
  assert.equal(system.reportMarkerCount(5658, 5, 1, 3000, 2, 150), null);
});

test("passes never go backwards in time", () => {
  const system = new ArucoTimingSystem();
  system.setListeningFrequencies([5695]);
  system.startDetection();
  system.reportMarkerCount(5695, 2, 1, 5000, 2, 150);
  assert.equal(system.reportMarkerCount(5695, 0, 0, 5000, 2, 150), null);
  assert.equal(system.reportMarkerCount(5695, 0, 0, 5150, 2, 150).time, 5000);
  system.reportMarkerCount(5695, 2, 1, 4000, 2, 150);
  system.reportMarkerCount(5695, 0, 0, 4100, 2, 150);
  assert.equal(system.reportMarkerCount(5695, 0, 0, 4250, 2, 150), null);
});

test("marker counts use the system's ids and the shared minimum size", () => {
  const detections = [
    { id: 0, areaPx: 100 },
    { id: 0, areaPx: 500.9 },
    { id: 4, areaPx: 9000 },
  ];
  assert.deepEqual(countMarkers(detections, [0], 0.1), { count: 1, peak: 500 });
  assert.deepEqual(countMarkers(detections, [0, 4], 0.05), { count: 3, peak: 9000 });
  const logs = [];
  const primary = new ArucoTimingSystem({ markerIds: "0", markerThreshold: 1, minMarkerPercent: 0.05 });
  const split = new ArucoTimingSystem({ markerIds: "4", markerThreshold: 9, role: "Primary" });
  enforceSinglePrimary([primary, split], (line) => logs.push(line));
  assert.equal(split.settings.role, "Split");
  assert.deepEqual(logs, ["only one Primary is allowed; demoting Marker(s) 4 to Split."]);
  assert.equal(sharedSettings([split, primary]), primary.settings);
  for (const system of [primary, split]) {
    system.setListeningFrequencies([5732]);
    system.startDetection();
  }
  reportChannelDetections([primary, split], 5732, detections, 100);
  assert.equal(primary.stateByFrequency.get(5732).inGate, true);
  assert.equal(split.stateByFrequency.get(5732).inGate, true, "the split system uses the primary's threshold of 1");
});

test("camera frames drive a lap detection end to end", () => {
  const detector = new ArucoMarkerDetector();
  const system = new ArucoTimingSystem();
  system.setListeningFrequencies([5769]);
  system.startDetection();
  const gate = frameWith([
    { id: 0, corners: square(120, 180, 45) },
    { id: 0, corners: square(360, 180, 45, 15) },
  ]);
  const empty = blankFrame(W, H);
  const passes = [];
  let time = 10_000;
  for (let frame = 0; frame < 12; frame += 1, time += 33) {
    const detections = detector.detect(frame < 4 ? gate : empty, W, H, "Hybrid", 0.6, 20);
    passes.push(...reportChannelDetections([system], 5769, detections, time));
  }
  assert.equal(passes.length, 1);
  assert.equal(passes[0].time, 10_000 + 33 * 9 - 150);
  assert.ok(passes[0].peak > 7000);
});

const colourFrame = (offset, saturated) => {
  const frame = new Uint8ClampedArray(64 * 48 * 4);
  for (let p = 0, i = 0; p < frame.length; p += 4, i += 1) {
    const value = (i * 7 + offset) % 200;
    frame[p] = saturated ? value : 90;
    frame[p + 1] = saturated ? 255 - value : 90;
    frame[p + 2] = saturated ? (value * 3) % 256 : 90;
    frame[p + 3] = 255;
  }
  return frame;
};

test("motion readings follow saturation and frame-difference hysteresis", () => {
  assert.equal(frameSaturation(colourFrame(0, false)), 0);
  assert.ok(frameSaturation(colourFrame(0, true)) > 20);
  assert.equal(frameDifference(colourFrame(0, true), null), 0);
  const detector = new MotionDetector();
  assert.equal(detector.detectMotion(0).state, MOTION_STATES.Unknown);
  for (let t = 0; t <= 4000; t += 100) detector.addFrame(colourFrame(t / 10, true), t);
  assert.equal(detector.detectMotion(4000).state, MOTION_STATES.ActiveMotion);
  for (let t = 4100; t <= 8200; t += 100) detector.addFrame(colourFrame(0, true), t);
  assert.equal(detector.detectMotion(8200).state, MOTION_STATES.ActiveNoMotion);
  for (let t = 8300; t <= 12400; t += 100) detector.addFrame(colourFrame(0, false), t);
  assert.equal(detector.detectMotion(12400).state, MOTION_STATES.InactiveNoMotion);
});

test("auto crash-out waits for the start delay, then crashes and recovers", () => {
  const crash = new AutoCrashOut({ startDelayMs: 8000 });
  crash.raceStarted(0);
  const run = (from, to, moving, crashedOut) => {
    let changes = [];
    for (let t = from; t <= to; t += 50) {
      crash.addFrame("R1", colourFrame(moving ? t / 5 : 0, true), t);
      crash.sample(t);
      changes = changes.concat(crash.update([{ key: "R1", crashedOut }], t).map((change) => ({ ...change, t })));
    }
    return changes;
  };
  assert.deepEqual(run(0, 8000, false, false), [], "no crash-out during the start delay");
  const crashed = run(8050, 12000, false, false);
  assert.equal(crashed[0].crashed, true);
  assert.equal(crashed[0].t, 8050);
  const recovered = run(12050, 20000, true, true);
  assert.equal(recovered[0].crashed, false);
  crash.raceEnded();
  assert.deepEqual(run(20050, 30000, false, false), [], "nothing after the race ends");
});

test("overlay labels and the 150 ms hold match the original", () => {
  const detection = { id: 7, areaPx: 1728, corners: [{ x: 0, y: 0 }] };
  assert.equal(markerLabel(detection, 172800), "ID:7  (1.0%)");
  assert.equal(markerLabel(detection, 172800, { showSizePercent: false }), "ID:7");
  assert.equal(markerLabel(detection, 172800, { showId: false }), "1.0%");
  const held = new HeldDetections();
  held.set([detection], 1000);
  assert.equal(held.active(1150).length, 1);
  assert.equal(held.active(1151).length, 0);
});

test("printable markers carry the code and refuse ids outside the dictionary", () => {
  const svg = markerSvg(0);
  const blackCells = 36 - DICT_4X4_50.bits(0).filter((bit) => bit === 1).length;
  assert.equal((svg.match(/<rect x=/g) ?? []).length, blackCells);
  assert.throws(() => markerSvg(50), RangeError);
});

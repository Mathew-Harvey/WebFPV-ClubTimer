// Lens calibration for the Corrected and Hybrid detection passes.
//
// parseCalibration follows FPVTrackside's Timing.Aruco.ArucoCalibration.TryLoad (TVPAS2 JSON:
// mtx 3x3, dist flat or nested, resolution [height, width] defaulting to 720x960).
// buildUndistortMaps follows ArucoMarkerDetector.ApplyCalibration: intrinsics scaled to the
// detection frame, getOptimalNewCameraMatrix(alpha 1), then initUndistortRectifyMap. The OpenCV
// math is reimplemented here; skew is ignored, as OpenCV does in these routines.

const DEFAULT_REFERENCE = { height: 720, width: 960 };

const finite = (value, label) => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} is not a number`);
  return number;
};

/** Returns { calibration } or { error } with TryLoad's reasons. */
export const parseCalibration = (input) => {
  let json;
  try {
    json = typeof input === "string" ? JSON.parse(input) : input;
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
  try {
    const mtx = Array.isArray(json?.mtx) ? json.mtx : null;
    if (mtx == null || mtx.length !== 3) return { error: "mtx missing or not 3x3" };
    const matrix = [];
    for (let row = 0; row < 3; row += 1) {
      if (!Array.isArray(mtx[row]) || mtx[row].length !== 3) return { error: `mtx row ${row} not length 3` };
      matrix.push(mtx[row].map((value, col) => finite(value, `mtx[${row}][${col}]`)));
    }
    const rawDist = Array.isArray(json.dist) ? json.dist : null;
    const coefficients = rawDist != null && rawDist.length > 0 && Array.isArray(rawDist[0]) ? rawDist[0] : rawDist;
    if (coefficients == null) return { error: "dist missing" };
    const dist = coefficients.map((value, index) => finite(value, `dist[${index}]`));
    let { height, width } = DEFAULT_REFERENCE;
    const resolution = Array.isArray(json.resolution) ? json.resolution : null;
    if (resolution != null && resolution.length >= 2) {
      height = Math.trunc(finite(resolution[0], "resolution[0]"));
      width = Math.trunc(finite(resolution[1], "resolution[1]"));
    }
    if (width <= 0 || height <= 0) return { error: "resolution must be positive" };
    return { calibration: { mtx: matrix, dist, referenceWidth: width, referenceHeight: height } };
  } catch (error) {
    return { error: `${error.name}: ${error.message}` };
  }
};

const coefficients = (dist) => {
  const d = (index) => dist[index] ?? 0;
  return {
    k1: d(0), k2: d(1), p1: d(2), p2: d(3), k3: d(4), k4: d(5), k5: d(6), k6: d(7),
    s1: d(8), s2: d(9), s3: d(10), s4: d(11),
  };
};

/** Apply the OpenCV distortion model to a normalized point. */
export const distortNormalized = (x, y, dist) => {
  const { k1, k2, p1, p2, k3, k4, k5, k6, s1, s2, s3, s4 } = coefficients(dist);
  const r2 = x * x + y * y;
  const r4 = r2 * r2;
  const r6 = r4 * r2;
  const radial = (1 + k1 * r2 + k2 * r4 + k3 * r6) / (1 + k4 * r2 + k5 * r4 + k6 * r6);
  return {
    x: x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x) + s1 * r2 + s2 * r4,
    y: y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y + s3 * r2 + s4 * r4,
  };
};

/** cv::undistortPoints to normalized coordinates (5 fixed-point iterations). */
export const undistortNormalized = (xd, yd, dist) => {
  const { k1, k2, p1, p2, k3, k4, k5, k6, s1, s2, s3, s4 } = coefficients(dist);
  let x = xd;
  let y = yd;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const r2 = x * x + y * y;
    const icdist = (1 + ((k6 * r2 + k5) * r2 + k4) * r2) / (1 + ((k3 * r2 + k2) * r2 + k1) * r2);
    if (icdist < 0) return { x: xd, y: yd };
    const deltaX = 2 * p1 * x * y + p2 * (r2 + 2 * x * x) + s1 * r2 + s2 * r2 * r2;
    const deltaY = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y + s3 * r2 + s4 * r2 * r2;
    x = (xd - deltaX) * icdist;
    y = (yd - deltaY) * icdist;
  }
  return { x, y };
};

/** cv::getOptimalNewCameraMatrix with centerPrincipalPoint false and newImgSize = imgSize. */
export const optimalNewCameraMatrix = (cameraMatrix, dist, width, height, alpha = 1) => {
  const fx = cameraMatrix[0][0];
  const fy = cameraMatrix[1][1];
  const cx = cameraMatrix[0][2];
  const cy = cameraMatrix[1][2];
  const n = 9;
  let ix0 = -Infinity;
  let ix1 = Infinity;
  let iy0 = -Infinity;
  let iy1 = Infinity;
  let ox0 = Infinity;
  let ox1 = -Infinity;
  let oy0 = Infinity;
  let oy1 = -Infinity;
  for (let gy = 0; gy < n; gy += 1) {
    for (let gx = 0; gx < n; gx += 1) {
      const u = (gx * (width - 1)) / (n - 1);
      const v = (gy * (height - 1)) / (n - 1);
      const p = undistortNormalized((u - cx) / fx, (v - cy) / fy, dist);
      ox0 = Math.min(ox0, p.x);
      ox1 = Math.max(ox1, p.x);
      oy0 = Math.min(oy0, p.y);
      oy1 = Math.max(oy1, p.y);
      if (gx === 0) ix0 = Math.max(ix0, p.x);
      if (gx === n - 1) ix1 = Math.min(ix1, p.x);
      if (gy === 0) iy0 = Math.max(iy0, p.y);
      if (gy === n - 1) iy1 = Math.min(iy1, p.y);
    }
  }
  const fx0 = (width - 1) / (ix1 - ix0);
  const fy0 = (height - 1) / (iy1 - iy0);
  const fx1 = (width - 1) / (ox1 - ox0);
  const fy1 = (height - 1) / (oy1 - oy0);
  return [
    [fx0 * (1 - alpha) + fx1 * alpha, 0, -fx0 * ix0 * (1 - alpha) + -fx1 * ox0 * alpha],
    [0, fy0 * (1 - alpha) + fy1 * alpha, -fy0 * iy0 * (1 - alpha) + -fy1 * oy0 * alpha],
    [0, 0, 1],
  ];
};

const invert3 = (m) => {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new RangeError("camera matrix is singular");
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
};

/** cv::initUndistortRectifyMap with R = identity and CV_32FC1 maps. */
export const undistortRectifyMap = (cameraMatrix, dist, newCameraMatrix, width, height) => {
  const fx = cameraMatrix[0][0];
  const fy = cameraMatrix[1][1];
  const cx = cameraMatrix[0][2];
  const cy = cameraMatrix[1][2];
  const ir = invert3(newCameraMatrix);
  const mapX = new Float32Array(width * height);
  const mapY = new Float32Array(width * height);
  for (let v = 0; v < height; v += 1) {
    for (let u = 0; u < width; u += 1) {
      const w = 1 / (ir[2][0] * u + ir[2][1] * v + ir[2][2]);
      const x = (ir[0][0] * u + ir[0][1] * v + ir[0][2]) * w;
      const y = (ir[1][0] * u + ir[1][1] * v + ir[1][2]) * w;
      const distorted = distortNormalized(x, y, dist);
      mapX[v * width + u] = fx * distorted.x + cx;
      mapY[v * width + u] = fy * distorted.y + cy;
    }
  }
  return { mapX, mapY };
};

/** ApplyCalibration: scale the reference intrinsics to the detection frame and build the maps. */
export const buildUndistortMaps = (calibration, width, height) => {
  const sx = width / calibration.referenceWidth;
  const sy = height / calibration.referenceHeight;
  const m = calibration.mtx;
  const cameraMatrix = [
    [m[0][0] * sx, m[0][1], m[0][2] * sx],
    [m[1][0], m[1][1] * sy, m[1][2] * sy],
    [m[2][0], m[2][1], m[2][2]],
  ];
  const newCameraMatrix = optimalNewCameraMatrix(cameraMatrix, calibration.dist, width, height, 1);
  return { ...undistortRectifyMap(cameraMatrix, calibration.dist, newCameraMatrix, width, height), cameraMatrix, newCameraMatrix };
};

/** cv::remap with INTER_LINEAR and a zero constant border. */
export const remapLinear = (gray, width, height, mapX, mapY, out = new Uint8Array(width * height)) => {
  const sample = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? gray[y * width + x] : 0);
  for (let index = 0; index < width * height; index += 1) {
    const sx = mapX[index];
    const sy = mapY[index];
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    const fx = sx - x0;
    const fy = sy - y0;
    const value =
      sample(x0, y0) * (1 - fx) * (1 - fy) +
      sample(x0 + 1, y0) * fx * (1 - fy) +
      sample(x0, y0 + 1) * (1 - fx) * fy +
      sample(x0 + 1, y0 + 1) * fx * fy;
    out[index] = Math.round(value);
  }
  return out;
};

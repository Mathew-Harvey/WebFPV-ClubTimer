// ArUco marker detection for camera lap timing.
//
// ArucoMarkerDetector mirrors FPVTrackside 2.78's Timing.Aruco.ArucoMarkerDetector (Timing.dll):
// grayscale conversion, Original/Corrected/Hybrid passes, corner mapping back through the
// undistortion maps, the 0-49 id filter, shoelace areas and the lost-signal ratio.
// detectMarkers() reimplements OpenCV 4.11's default ArUco detector, which FPVTrackside calls
// through OpenCvSharp with default DetectorParameters except errorCorrectionRate.
import { DICT_4X4_50 } from "./aruco-dictionary.js";
import { buildUndistortMaps, remapLinear } from "./calibration.js";

export const DETECT_MODES = Object.freeze(["Original", "Corrected", "Hybrid"]);

/** OpenCV 4.11 aruco::DetectorParameters defaults used by the detector. */
export const DETECTOR_DEFAULTS = Object.freeze({
  adaptiveThreshWinSizeMin: 3,
  adaptiveThreshWinSizeMax: 23,
  adaptiveThreshWinSizeStep: 10,
  adaptiveThreshConstant: 7,
  minMarkerPerimeterRate: 0.03,
  maxMarkerPerimeterRate: 4,
  polygonalApproxAccuracyRate: 0.03,
  minCornerDistanceRate: 0.05,
  minDistanceToBorder: 3,
  minMarkerDistanceRate: 0.125,
  minGroupDistance: 0.21,
  markerBorderBits: 1,
  perspectiveRemovePixelPerCell: 4,
  perspectiveRemoveIgnoredMarginPerCell: 0.13,
  maxErroneousBitsInBorderRate: 0.35,
  minOtsuStdDev: 5,
  errorCorrectionRate: 0.6,
});

/** OpenCV RGB(A) to gray with its fixed-point BT.601 weights. */
export const rgbaToGray = (rgba, width, height, out = new Uint8Array(width * height)) => {
  for (let index = 0, pixel = 0; index < width * height; index += 1, pixel += 4) {
    out[index] = (rgba[pixel] * 4899 + rgba[pixel + 1] * 9617 + rgba[pixel + 2] * 1868 + 8192) >> 14;
  }
  return out;
};

export const contourArea = (points) => {
  if (points == null || points.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const p = points[index];
    const q = points[(index + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return Math.abs(sum) * 0.5;
};

export const centroid = (points) => {
  if (points == null || points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
};

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---- Thresholding ------------------------------------------------------------------

/** Summed-area table of the image padded with replicated edges (BORDER_REPLICATE). */
const replicatedIntegral = (gray, width, height, pad) => {
  const paddedWidth = width + 2 * pad;
  const paddedHeight = height + 2 * pad;
  const stride = paddedWidth + 1;
  const sums = new Float64Array(stride * (paddedHeight + 1));
  for (let y = 0; y < paddedHeight; y += 1) {
    const sourceRow = Math.min(height - 1, Math.max(0, y - pad)) * width;
    let rowSum = 0;
    for (let x = 0; x < paddedWidth; x += 1) {
      rowSum += gray[sourceRow + Math.min(width - 1, Math.max(0, x - pad))];
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + rowSum;
    }
  }
  return { sums, stride, pad };
};

/**
 * adaptiveThreshold(ADAPTIVE_THRESH_MEAN_C, THRESH_BINARY_INV): 1 where the pixel is at least
 * `constant` darker than its window mean. The frame edge is cleared because findContours
 * treats it as background.
 */
const thresholdInto = (gray, width, height, integral, windowSize, constant, out) => {
  const radius = windowSize >> 1;
  const area = windowSize * windowSize;
  const delta = Math.floor(constant);
  const { sums, stride, pad } = integral;
  for (let y = 0; y < height; y += 1) {
    const top = (y + pad - radius) * stride;
    const bottom = (y + pad + radius + 1) * stride;
    for (let x = 0; x < width; x += 1) {
      const left = x + pad - radius;
      const right = x + pad + radius + 1;
      const sum = sums[bottom + right] - sums[top + right] - sums[bottom + left] + sums[top + left];
      out[y * width + x] = gray[y * width + x] - Math.round(sum / area) <= -delta ? 1 : 0;
    }
  }
  for (let x = 0; x < width; x += 1) {
    out[x] = 0;
    out[(height - 1) * width + x] = 0;
  }
  for (let y = 0; y < height; y += 1) {
    out[y * width] = 0;
    out[y * width + width - 1] = 0;
  }
};

// ---- Contours (Suzuki-Abe border following, RETR_LIST + CHAIN_APPROX_NONE) ---------

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

const followBorder = (labels, width, x0, y0, startDirection, border, xs, ys) => {
  let count = 0;
  let firstDirection = -1;
  for (let step = 0; step < 8; step += 1) {
    const direction = (startDirection + step) & 7;
    if (labels[(y0 + DY[direction]) * width + x0 + DX[direction]] !== 0) {
      firstDirection = direction;
      break;
    }
  }
  if (firstDirection < 0) {
    labels[y0 * width + x0] = -border;
    xs[0] = x0;
    ys[0] = y0;
    return 1;
  }
  const x1 = x0 + DX[firstDirection];
  const y1 = y0 + DY[firstDirection];
  let x3 = x0;
  let y3 = y0;
  let previousDirection = firstDirection;
  for (;;) {
    if (count < xs.length) {
      xs[count] = x3;
      ys[count] = y3;
    }
    count += 1;
    let nextDirection = -1;
    let eastWasZero = false;
    for (let step = 1; step <= 8; step += 1) {
      const direction = (previousDirection - step + 8) & 7;
      if (labels[(y3 + DY[direction]) * width + x3 + DX[direction]] !== 0) {
        nextDirection = direction;
        break;
      }
      if (direction === 0) eastWasZero = true;
    }
    const at = y3 * width + x3;
    if (eastWasZero) labels[at] = -border;
    else if (labels[at] === 1) labels[at] = border;
    const x4 = x3 + DX[nextDirection];
    const y4 = y3 + DY[nextDirection];
    if (x4 === x0 && y4 === y0 && x3 === x1 && y3 === y1) return count;
    previousDirection = (nextDirection + 4) & 7;
    x3 = x4;
    y3 = y4;
  }
};

/** Calls visit(xs, ys, count) for every outer and hole border in a 0/1 Int32Array. */
const forEachContour = (labels, width, height, maxPoints, visit) => {
  const xs = new Int32Array(maxPoints + 1);
  const ys = new Int32Array(maxPoints + 1);
  let border = 1;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = y * width + x;
      const value = labels[at];
      if (value === 0) continue;
      let start;
      if (value === 1 && labels[at - 1] === 0) start = 4;
      else if (value >= 1 && labels[at + 1] === 0) start = 0;
      else continue;
      border += 1;
      const count = followBorder(labels, width, x, y, start, border, xs, ys);
      visit(xs, ys, count);
    }
  }
};

// ---- Polygon approximation (OpenCV approxPolyDP, closed curves) --------------------

const approxPolyClosed = (xs, ys, count, epsilon) => {
  const eps = epsilon * epsilon;
  const stack = [];
  const out = [];
  let pos = 0;
  let rightStart = 0;
  let startX = 0;
  let startY = 0;
  let withinEps = false;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    let maxDist = 0;
    pos = (pos + rightStart) % count;
    startX = xs[pos];
    startY = ys[pos];
    pos = (pos + 1) % count;
    for (let j = 1; j < count; j += 1) {
      const dx = xs[pos] - startX;
      const dy = ys[pos] - startY;
      pos = (pos + 1) % count;
      const dist = dx * dx + dy * dy;
      if (dist > maxDist) {
        maxDist = dist;
        rightStart = j;
      }
    }
    withinEps = maxDist <= eps;
  }
  if (withinEps) return [{ x: startX, y: startY }];
  const sliceStart = pos % count;
  const sliceEnd = (rightStart + sliceStart) % count;
  stack.push([sliceEnd, sliceStart]);
  stack.push([sliceStart, sliceEnd]);
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    const endX = xs[end];
    const endY = ys[end];
    let cursor = start;
    const sx = xs[cursor];
    const sy = ys[cursor];
    cursor = (cursor + 1) % count;
    let split = -1;
    let keep;
    if (cursor !== end) {
      const dx = endX - sx;
      const dy = endY - sy;
      let maxDist = 0;
      while (cursor !== end) {
        const dist = Math.abs((ys[cursor] - sy) * dx - (xs[cursor] - sx) * dy);
        cursor = (cursor + 1) % count;
        if (dist > maxDist) {
          maxDist = dist;
          split = (cursor + count - 1) % count;
        }
      }
      keep = maxDist * maxDist <= eps * (dx * dx + dy * dy);
    } else {
      keep = true;
    }
    if (keep) out.push({ x: sx, y: sy });
    else {
      stack.push([split, end]);
      stack.push([start, split]);
    }
  }
  // Final pass: drop points that sit on an (almost) straight line between their neighbours.
  let n = out.length;
  if (n <= 2) return out;
  const dst = out.slice();
  let readPos = n - 1;
  const read = () => {
    const point = dst[readPos];
    readPos = readPos + 1 >= n ? 0 : readPos + 1;
    return point;
  };
  let start = read();
  let writePos = readPos;
  let pt = read();
  let newCount = n;
  for (let i = 0; i < n && newCount > 2; i += 1) {
    const end = read();
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.abs((pt.x - start.x) * dy - (pt.y - start.y) * dx);
    const inner = (pt.x - start.x) * (end.x - pt.x) + (pt.y - start.y) * (end.y - pt.y);
    if (dist * dist <= 0.5 * eps * (dx * dx + dy * dy) && dx !== 0 && dy !== 0 && inner >= 0) {
      newCount -= 1;
      dst[writePos] = start = end;
      writePos = writePos + 1 >= n ? 0 : writePos + 1;
      pt = read();
      i += 1;
      continue;
    }
    dst[writePos] = start = pt;
    writePos = writePos + 1 >= n ? 0 : writePos + 1;
    pt = end;
  }
  return dst.slice(0, newCount);
};

const isConvex = (points) => {
  const n = points.length;
  let previous = points[(n - 2 + n) % n];
  let current = points[n - 1];
  let dx0 = current.x - previous.x;
  let dy0 = current.y - previous.y;
  let orientation = 0;
  for (let index = 0; index < n; index += 1) {
    previous = current;
    current = points[index];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const dxdy0 = dx * dy0;
    const dydx0 = dy * dx0;
    orientation |= dydx0 > dxdy0 ? 1 : dydx0 < dxdy0 ? 2 : 3;
    if (orientation === 3) return false;
    dx0 = dx;
    dy0 = dy;
  }
  return true;
};

// ---- Candidate search ----------------------------------------------------------------

const findCandidates = (labels, width, height, params, candidates) => {
  const longest = Math.max(width, height);
  const minPerimeter = Math.trunc(params.minMarkerPerimeterRate * longest);
  const maxPerimeter = Math.trunc(params.maxMarkerPerimeterRate * longest);
  const border = params.minDistanceToBorder;
  forEachContour(labels, width, height, maxPerimeter, (xs, ys, count) => {
    if (count < minPerimeter || count > maxPerimeter) return;
    const approx = approxPolyClosed(xs, ys, count, count * params.polygonalApproxAccuracyRate);
    if (approx.length !== 4 || !isConvex(approx)) return;
    let minDistSq = longest * longest;
    for (let j = 0; j < 4; j += 1) {
      const dx = approx[j].x - approx[(j + 1) % 4].x;
      const dy = approx[j].y - approx[(j + 1) % 4].y;
      minDistSq = Math.min(minDistSq, dx * dx + dy * dy);
    }
    const minCornerDistance = count * params.minCornerDistanceRate;
    if (minDistSq < minCornerDistance * minCornerDistance) return;
    for (const point of approx) {
      if (point.x < border || point.y < border || point.x > width - 1 - border || point.y > height - 1 - border) return;
    }
    candidates.push({ corners: approx.map((point) => ({ x: point.x, y: point.y })), perimeter: count });
  });
};

const reorderClockwise = (corners) => {
  const dx1 = corners[1].x - corners[0].x;
  const dy1 = corners[1].y - corners[0].y;
  const dx2 = corners[2].x - corners[0].x;
  const dy2 = corners[2].y - corners[0].y;
  if (dx1 * dy2 - dy1 * dx2 < 0) [corners[1], corners[3]] = [corners[3], corners[1]];
};

const averageDistance = (a, b) => {
  let best = Infinity;
  for (let first = 0; first < 4; first += 1) {
    let sum = 0;
    for (let c = 0; c < 4; c += 1) {
      const p = a[(c + first) % 4];
      sum += (p.x - b[c].x) ** 2 + (p.y - b[c].y) ** 2;
    }
    best = Math.min(best, sum / 4);
  }
  return Math.sqrt(best);
};

const averageModuleSize = (corners, markerSize, borderBits) => {
  let total = 0;
  for (let index = 0; index < 4; index += 1) total += distance(corners[index], corners[(index + 1) % 4]);
  return total / (4 * (markerSize + 2 * borderBits));
};

const pointInPolygon = (polygon, point) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const onEdge =
      Math.abs((b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)) < 1e-9 &&
      point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) &&
      point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y);
    if (onEdge) return true;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
};

/** OpenCV 4.9+ filterTooCloseCandidates: keep the largest of each nested group, remember the rest. */
const selectCandidates = (candidates, params, markerSize) => {
  const sorted = candidates
    .map((candidate, index) => ({ ...candidate, index, closeContours: [], parent: -1, depth: 0 }))
    .sort((left, right) => right.perimeter - left.perimeter || left.index - right.index);
  const groupId = new Array(sorted.length).fill(-1);
  const groups = [];
  const selected = new Array(sorted.length).fill(true);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (averageDistance(sorted[i].corners, sorted[j].corners) >= sorted[j].perimeter * params.minMarkerDistanceRate) continue;
      selected[i] = false;
      selected[j] = false;
      if (groupId[i] < 0 && groupId[j] < 0) {
        groupId[i] = groupId[j] = groups.length;
        groups.push([i, j]);
      } else if (groupId[i] > -1 && groupId[j] === -1) {
        groupId[j] = groupId[i];
        groups[groupId[i]].push(j);
      } else if (groupId[j] > -1 && groupId[i] === -1) {
        groupId[i] = groupId[j];
        groups[groupId[j]].push(i);
      }
    }
  }
  for (const group of groups) {
    group.sort((left, right) => left - right);
    let current = group[0];
    selected[current] = true;
    for (let k = 1; k < group.length; k += 1) {
      const id = group[k];
      const gap = averageDistance(sorted[id].corners, sorted[current].corners);
      const module = averageModuleSize(sorted[id].corners, markerSize, params.markerBorderBits);
      if (gap > params.minGroupDistance * module) {
        current = id;
        sorted[group[0]].closeContours.push(sorted[id]);
      }
    }
  }
  const chosen = sorted.filter((_, index) => selected[index]);
  for (let i = chosen.length - 1; i >= 0; i -= 1) {
    for (let j = i - 1; j >= 0; j -= 1) {
      if (chosen[i].corners.every((corner) => pointInPolygon(chosen[j].corners, corner))) {
        chosen[i].parent = j;
        chosen[j].depth = Math.max(chosen[j].depth, chosen[i].depth + 1);
        break;
      }
    }
  }
  return chosen;
};

// ---- Bit extraction --------------------------------------------------------------------

/** Homography mapping each of 4 source points onto 4 destination points (getPerspectiveTransform). */
export const perspectiveTransform = (from, to) => {
  const a = [];
  for (let k = 0; k < 4; k += 1) {
    const { x, y } = from[k];
    const { x: u, y: v } = to[k];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < 8; row += 1) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      for (let k = col; k < 9; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  const h = a.map((row, index) => row[8] / row[index]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
};

const otsuThreshold = (pixels) => {
  const histogram = new Float64Array(256);
  for (const value of pixels) histogram[value] += 1;
  const scale = 1 / pixels.length;
  let mu = 0;
  for (let i = 0; i < 256; i += 1) mu += i * histogram[i];
  mu *= scale;
  let mu1 = 0;
  let q1 = 0;
  let maxSigma = 0;
  let maxValue = 0;
  const epsilon = 1.1920928955078125e-7;
  for (let i = 0; i < 256; i += 1) {
    const p = histogram[i] * scale;
    mu1 *= q1;
    q1 += p;
    const q2 = 1 - q1;
    if (Math.min(q1, q2) < epsilon || Math.max(q1, q2) > 1 - epsilon) continue;
    mu1 = (mu1 + i * p) / q1;
    const mu2 = (mu - q1 * mu1) / q2;
    const sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2);
    if (sigma > maxSigma) {
      maxSigma = sigma;
      maxValue = i;
    }
  }
  return maxValue;
};

const extractBits = (gray, width, height, corners, markerSize, params) => {
  const cells = markerSize + 2 * params.markerBorderBits;
  const cellSize = params.perspectiveRemovePixelPerCell;
  const margin = Math.trunc(params.perspectiveRemoveIgnoredMarginPerCell * cellSize);
  const side = cells * cellSize;
  const target = [
    { x: 0, y: 0 },
    { x: side - 1, y: 0 },
    { x: side - 1, y: side - 1 },
    { x: 0, y: side - 1 },
  ];
  const h = perspectiveTransform(target, corners);
  if (h == null) return null;
  const warped = new Uint8Array(side * side);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const w = h[6] * x + h[7] * y + h[8];
      const inverse = w === 0 ? 0 : 1 / w;
      const sx = Math.round((h[0] * x + h[1] * y + h[2]) * inverse);
      const sy = Math.round((h[3] * x + h[4] * y + h[5]) * inverse);
      warped[y * side + x] = sx >= 0 && sy >= 0 && sx < width && sy < height ? gray[sy * width + sx] : 0;
    }
  }
  const bits = new Uint8Array(cells * cells);
  const inset = cellSize >> 1;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = inset; y < side - inset; y += 1) {
    for (let x = inset; x < side - inset; x += 1) {
      const value = warped[y * side + x];
      sum += value;
      sumSq += value * value;
      n += 1;
    }
  }
  const mean = sum / n;
  const stddev = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  if (stddev < params.minOtsuStdDev) {
    bits.fill(mean > 127 ? 1 : 0);
    return bits;
  }
  const threshold = otsuThreshold(warped);
  const inner = cellSize - 2 * margin;
  for (let cy = 0; cy < cells; cy += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      let white = 0;
      for (let y = 0; y < inner; y += 1) {
        for (let x = 0; x < inner; x += 1) {
          if (warped[(cy * cellSize + margin + y) * side + cx * cellSize + margin + x] > threshold) white += 1;
        }
      }
      if (white > (inner * inner) / 2) bits[cy * cells + cx] = 1;
    }
  }
  return bits;
};

const borderErrors = (bits, markerSize, borderBits) => {
  const size = markerSize + 2 * borderBits;
  let errors = 0;
  for (let y = 0; y < size; y += 1) {
    for (let k = 0; k < borderBits; k += 1) {
      if (bits[y * size + k] !== 0) errors += 1;
      if (bits[y * size + size - 1 - k] !== 0) errors += 1;
    }
  }
  for (let x = borderBits; x < size - borderBits; x += 1) {
    for (let k = 0; k < borderBits; k += 1) {
      if (bits[k * size + x] !== 0) errors += 1;
      if (bits[(size - 1 - k) * size + x] !== 0) errors += 1;
    }
  }
  return errors;
};

const identifyCandidate = (gray, width, height, corners, dictionary, params) => {
  const bits = extractBits(gray, width, height, corners, dictionary.markerSize, params);
  if (bits == null) return null;
  const maxBorderErrors = Math.trunc(dictionary.markerSize * dictionary.markerSize * params.maxErroneousBitsInBorderRate);
  if (borderErrors(bits, dictionary.markerSize, params.markerBorderBits) > maxBorderErrors) return null;
  const size = dictionary.markerSize + 2 * params.markerBorderBits;
  const inner = [];
  for (let y = params.markerBorderBits; y < size - params.markerBorderBits; y += 1) {
    for (let x = params.markerBorderBits; x < size - params.markerBorderBits; x += 1) inner.push(bits[y * size + x]);
  }
  return dictionary.identify(inner, params.errorCorrectionRate);
};

/**
 * Detect markers in an 8-bit grayscale image. Returns [{ id, corners: [{x,y} x4] }] with corner 0
 * at the marker's top-left and the rest clockwise, matching cv::aruco::detectMarkers.
 */
export const detectMarkers = (gray, width, height, dictionary = DICT_4X4_50, overrides = {}) => {
  const params = { ...DETECTOR_DEFAULTS, ...overrides };
  const scales = Math.trunc((params.adaptiveThreshWinSizeMax - params.adaptiveThreshWinSizeMin) / params.adaptiveThreshWinSizeStep) + 1;
  const windows = [];
  for (let i = 0; i < scales; i += 1) {
    let size = params.adaptiveThreshWinSizeMin + i * params.adaptiveThreshWinSizeStep;
    if (size % 2 === 0) size += 1;
    if (size >= 3) windows.push(size);
  }
  const integral = replicatedIntegral(gray, width, height, Math.max(...windows) >> 1);
  const labels = new Int32Array(width * height);
  const candidates = [];
  for (const windowSize of windows) {
    thresholdInto(gray, width, height, integral, windowSize, params.adaptiveThreshConstant, labels);
    findCandidates(labels, width, height, params, candidates);
  }
  for (const candidate of candidates) reorderClockwise(candidate.corners);
  const chosen = selectCandidates(candidates, params, dictionary.markerSize);

  const result = new Array(chosen.length).fill(null);
  const visited = new Array(chosen.length).fill(false);
  const maxDepth = chosen.reduce((max, candidate) => Math.max(max, candidate.depth), 0);
  const byDepth = Array.from({ length: maxDepth + 1 }, () => []);
  chosen.forEach((candidate, index) => byDepth[candidate.depth].push(index));
  let counter = 0;
  for (let depth = 0; counter < chosen.length && depth <= maxDepth; depth += 1) {
    for (const index of byDepth[depth]) {
      if (visited[index]) continue;
      visited[index] = true;
      const candidate = chosen[index];
      let corners = candidate.corners;
      let match = identifyCandidate(gray, width, height, corners, dictionary, params);
      if (match == null) {
        for (const close of candidate.closeContours) {
          match = identifyCandidate(gray, width, height, close.corners, dictionary, params);
          if (match != null) {
            corners = close.corners;
            break;
          }
        }
      }
      if (match != null) result[index] = { id: match.id, rotation: match.rotation, corners };
    }
    for (const index of byDepth[depth]) {
      if (result[index] != null) {
        for (let parent = chosen[index].parent; parent !== -1; parent = chosen[parent].parent) {
          if (!visited[parent]) {
            visited[parent] = true;
            counter += 1;
          }
        }
      }
      counter += 1;
    }
  }
  const markers = [];
  for (const found of result) {
    if (found == null) continue;
    const shift = (4 - found.rotation) % 4;
    const corners = [0, 1, 2, 3].map((k) => found.corners[(k + shift) % 4]);
    markers.push({ id: found.id, corners: corners.map((point) => ({ x: point.x, y: point.y })) });
  }
  return markers;
};

// ---- FPVTrackside detector --------------------------------------------------------------

/** Timing.Aruco.ArucoMarkerDetector: one per video channel. */
export class ArucoMarkerDetector {
  constructor(dictionary = DICT_4X4_50) {
    this.dictionary = dictionary;
    this.params = { ...DETECTOR_DEFAULTS };
    this.cachedEcRate = this.params.errorCorrectionRate;
    this.maps = null;
  }

  get hasCalibration() {
    return this.maps != null;
  }

  /** Intrinsics are scaled from the calibration's reference resolution to the detection frame. */
  applyCalibration(calibration, targetWidth, targetHeight) {
    this.maps = null;
    if (calibration == null) return;
    try {
      this.maps = { ...buildUndistortMaps(calibration, targetWidth, targetHeight), width: targetWidth, height: targetHeight };
    } catch {
      this.maps = null;
    }
  }

  #detectInto(gray, width, height, into, source) {
    for (const marker of detectMarkers(gray, width, height, this.dictionary, this.params)) {
      if (marker.id < 0 || marker.id > 49) continue;
      into.push({ id: marker.id, corners: marker.corners, areaPx: contourArea(marker.corners), source });
    }
  }

  /** Detect(bgra, width, height, mode, ecRate, hybridDistPx) with RGBA input. */
  detect(rgba, width, height, mode = "Hybrid", ecRate = 0.6, hybridDistPx = 20) {
    if (Math.abs(ecRate - this.cachedEcRate) > 0.001) {
      this.params.errorCorrectionRate = ecRate;
      this.cachedEcRate = ecRate;
    }
    const results = [];
    const gray = rgbaToGray(rgba, width, height);
    if (mode === "Original" || mode === "Hybrid") {
      try {
        this.#detectInto(gray, width, height, results, "Original");
      } catch {
        // FPVTrackside logs and keeps going with whatever the other pass finds.
      }
    }
    const mapsFit = this.hasCalibration && this.maps.width === width && this.maps.height === height;
    if (mapsFit && (mode === "Corrected" || mode === "Hybrid")) {
      try {
        const { mapX, mapY } = this.maps;
        const undistorted = remapLinear(gray, width, height, mapX, mapY);
        const corrected = [];
        this.#detectInto(undistorted, width, height, corrected, "Corrected");
        for (const detection of corrected) {
          for (const corner of detection.corners) {
            const x = Math.trunc(corner.x);
            const y = Math.trunc(corner.y);
            if (x >= 0 && x < width && y >= 0 && y < height) {
              corner.x = mapX[y * width + x];
              corner.y = mapY[y * width + x];
            }
          }
          detection.areaPx = contourArea(detection.corners);
          if (mode === "Hybrid") {
            const center = centroid(detection.corners);
            const match = results.find(
              (other) => other.id === detection.id && distance(centroid(other.corners), center) < hybridDistPx,
            );
            if (match != null) {
              match.source = "Both";
              match.corners = detection.corners;
              match.areaPx = detection.areaPx;
            } else {
              results.push(detection);
            }
          } else {
            results.push(detection);
          }
        }
      } catch {
        // Same as the Original pass: a failed Corrected pass leaves the frame's other results.
      }
    }
    return results;
  }

  dispose() {
    this.maps = null;
  }
}

// ---- Lost-signal ratio ----------------------------------------------------------------

const resizeLinear = (src, srcWidth, srcHeight, dstWidth, dstHeight) => {
  const out = new Uint8Array(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  const axis = (d, scale, size) => {
    let f = (d + 0.5) * scale - 0.5;
    let s = Math.floor(f);
    f -= s;
    if (s < 0) {
      s = 0;
      f = 0;
    }
    if (s >= size - 1) {
      s = size - 1;
      f = 0;
    }
    return [s, Math.min(s + 1, size - 1), f];
  };
  for (let dy = 0; dy < dstHeight; dy += 1) {
    const [y0, y1, fy] = axis(dy, scaleY, srcHeight);
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const [x0, x1, fx] = axis(dx, scaleX, srcWidth);
      const top = src[y0 * srcWidth + x0] * (1 - fx) + src[y0 * srcWidth + x1] * fx;
      const bottom = src[y1 * srcWidth + x0] * (1 - fx) + src[y1 * srcWidth + x1] * fx;
      out[dy * dstWidth + dx] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return out;
};

const stdDev = (pixels) => {
  let sum = 0;
  let sumSq = 0;
  for (const value of pixels) {
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / pixels.length;
  return Math.sqrt(Math.max(0, sumSq / pixels.length - mean * mean));
};

const reflect101 = (index, size) => {
  if (size === 1) return 0;
  let i = index;
  while (i < 0 || i >= size) i = i < 0 ? -i : 2 * size - 2 - i;
  return i;
};

const gaussianBlur = (src, width, height, ksize, sigmaIn) => {
  const sigma = sigmaIn > 0 ? sigmaIn : 0.3 * ((ksize - 1) * 0.5 - 1) + 0.8;
  const half = (ksize - 1) / 2;
  const kernel = Array.from({ length: ksize }, (_, i) => Math.exp(-((i - half) ** 2) / (2 * sigma * sigma)));
  const total = kernel.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < ksize; i += 1) kernel[i] /= total;
  const rows = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = 0; k < ksize; k += 1) value += kernel[k] * src[y * width + reflect101(x + k - half, width)];
      rows[y * width + x] = value;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = 0;
      for (let k = 0; k < ksize; k += 1) value += kernel[k] * rows[reflect101(y + k - half, height) * width + x];
      out[y * width + x] = Math.min(255, Math.max(0, Math.round(value)));
    }
  }
  return out;
};

/**
 * ArucoMarkerDetector.SignalRatio: spread left after a 15x15 blur divided by the spread before
 * it, on an 80x60 gray thumbnail. Analogue snow is fine-grained, so blurring removes most of its
 * spread and the ratio falls. A flat frame (spread under 3) scores 0; bad input scores 1.
 */
export const signalRatio = (rgba, width, height) => {
  if (rgba == null || rgba.length < width * height * 4) return 1;
  try {
    const small = resizeLinear(rgbaToGray(rgba, width, height), width, height, 80, 60);
    const spread = stdDev(small);
    if (spread < 3) return 0;
    return stdDev(gaussianBlur(small, 80, 60, 15, 0)) / spread;
  } catch {
    return 1;
  }
};

export const isLostSignal = (rgba, width, height, threshold) => signalRatio(rgba, width, height) < threshold;

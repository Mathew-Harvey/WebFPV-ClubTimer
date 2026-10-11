// Printable DICT_4X4_50 markers (black border, 4x4 code) and synthetic frames for testing.
import { DICT_4X4_50 } from "./aruco-dictionary.js";

/** Cell grid with the one-cell black border; 1 = white. */
export const markerGrid = (id, dictionary = DICT_4X4_50) => {
  if (!Number.isInteger(id) || id < 0 || id >= dictionary.size) throw new RangeError(`marker id must be 0-${dictionary.size - 1}`);
  const size = dictionary.markerSize + 2;
  const bits = dictionary.bits(id);
  const grid = new Uint8Array(size * size);
  for (let y = 0; y < dictionary.markerSize; y += 1) {
    for (let x = 0; x < dictionary.markerSize; x += 1) grid[(y + 1) * size + x + 1] = bits[y * dictionary.markerSize + x];
  }
  return { size, grid };
};

/** SVG for one marker with a white quiet zone one cell wide, sized in millimetres. */
export const markerSvg = (id, { sizeMm = 150, dictionary = DICT_4X4_50, caption = true } = {}) => {
  const { size, grid } = markerGrid(id, dictionary);
  const total = size + 2;
  const rects = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (grid[y * size + x] === 0) rects.push(`<rect x="${x + 1}" y="${y + 1}" width="1.02" height="1.02"/>`);
    }
  }
  const label = caption
    ? `<text x="${total / 2}" y="${total - 0.25}" font-size="0.45" text-anchor="middle" font-family="sans-serif" fill="#555">ArUco 4x4_50 · ID ${id}</text>`
    : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizeMm}mm" height="${sizeMm}mm" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><g fill="#000">${rects.join("")}</g>${label}</svg>`
  );
};

const inverseHomography = (corners, side) => {
  // Maps marker-grid coordinates (0..side) onto image points; solved as in getPerspectiveTransform.
  const from = [
    { x: 0, y: 0 },
    { x: side, y: 0 },
    { x: side, y: side },
    { x: 0, y: side },
  ];
  const a = [];
  for (let k = 0; k < 4; k += 1) {
    const { x: u, y: v } = corners[k];
    const { x, y } = from[k];
    a.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    a.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
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

/**
 * Paint a marker into an RGBA frame with its outer black border at the given image corners
 * (top-left, top-right, bottom-right, bottom-left), supersampled for soft edges.
 */
export const paintMarker = (rgba, width, height, id, corners, { dictionary = DICT_4X4_50, samples = 3 } = {}) => {
  const { size, grid } = markerGrid(id, dictionary);
  const h = inverseHomography(corners, size);
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(width - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      let inside = 0;
      let white = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const u = x + (sx + 0.5) / samples - 0.5;
          const v = y + (sy + 0.5) / samples - 0.5;
          const w = h[6] * u + h[7] * v + h[8];
          const gx = (h[0] * u + h[1] * v + h[2]) / w;
          const gy = (h[3] * u + h[4] * v + h[5]) / w;
          if (gx < 0 || gy < 0 || gx >= size || gy >= size) continue;
          inside += 1;
          if (grid[Math.floor(gy) * size + Math.floor(gx)] === 1) white += 1;
        }
      }
      if (inside === 0) continue;
      const total = samples * samples;
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const background = rgba[p + c];
        rgba[p + c] = Math.round((background * (total - inside) + 255 * white) / total);
      }
      rgba[p + 3] = 255;
    }
  }
};

/** A light-grey RGBA frame, the backdrop for synthetic marker tests and the on-screen demo. */
export const blankFrame = (width, height, gray = 200) => {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < rgba.length; p += 4) {
    rgba[p] = gray;
    rgba[p + 1] = gray;
    rgba[p + 2] = gray;
    rgba[p + 3] = 255;
  }
  return rgba;
};

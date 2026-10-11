/** Track pieces the editor can place. Course pieces are flown through in order; cones only mark the line. */
export const PIECES = {
  finish: { title: "Start/finish gate", course: true, width: 2.5, depth: 0.6, color: "#f0b429" },
  gate: { title: "Gate", course: true, width: 2, depth: 0.5, color: "#3b7de0" },
  dive: { title: "Dive gate", course: true, width: 2, depth: 2, color: "#d45bd0" },
  flag: { title: "Flag", course: true, width: 0.6, depth: 0.6, color: "#3cbe73" },
  cone: { title: "Cone", course: false, width: 0.5, depth: 0.5, color: "#e07a32" },
};

export const MAX_PIECES = 200;
export const DEFAULT_TRACK = Object.freeze({ widthMeters: 60, depthMeters: 40, gridMeters: 1, pieces: [] });

export const snap = (value, grid) => (grid > 0 ? Math.round(value / grid) * grid : value);

export const coursePieces = (track) =>
  track.pieces
    .filter((piece) => PIECES[piece.type]?.course)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

/** One lap is the path through each course piece in order and back to the first. */
export const lapLengthMeters = (track) => {
  const course = coursePieces(track);
  if (course.length < 2) return 0;
  let total = 0;
  for (let index = 0; index < course.length; index += 1) {
    const from = course[index];
    const to = course[(index + 1) % course.length];
    total += Math.hypot(to.x - from.x, to.y - from.y);
  }
  return Math.round(total * 10) / 10;
};

export const speedKmh = (meters, seconds) =>
  meters > 0 && seconds > 0 ? Math.round((meters / seconds) * 3.6 * 10) / 10 : null;

export const addPiece = (track, type, x, y, id) => {
  if (PIECES[type] == null) return track;
  if (track.pieces.length >= MAX_PIECES) return track;
  const order = PIECES[type].course ? coursePieces(track).length + 1 : null;
  return { ...track, pieces: [...track.pieces, { id, type, x, y, rotation: 0, order }] };
};

export const updatePiece = (track, id, patch) => ({
  ...track,
  pieces: track.pieces.map((piece) => (piece.id === id ? { ...piece, ...patch } : piece)),
});

/** Removing a course piece closes the gap in the course order. */
export const removePiece = (track, id) => {
  const pieces = track.pieces.filter((piece) => piece.id !== id);
  const course = pieces.filter((piece) => PIECES[piece.type]?.course).sort((left, right) => left.order - right.order);
  const renumbered = new Map(course.map((piece, index) => [piece.id, index + 1]));
  return { ...track, pieces: pieces.map((piece) => (renumbered.has(piece.id) ? { ...piece, order: renumbered.get(piece.id) } : piece)) };
};

/** Move a course piece earlier or later in the lap. */
export const moveInCourse = (track, id, step) => {
  const course = coursePieces(track);
  const index = course.findIndex((piece) => piece.id === id);
  const target = index + step;
  if (index < 0 || target < 0 || target >= course.length) return track;
  const swapped = [...course];
  [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
  const orders = new Map(swapped.map((piece, position) => [piece.id, position + 1]));
  return { ...track, pieces: track.pieces.map((piece) => (orders.has(piece.id) ? { ...piece, order: orders.get(piece.id) } : piece)) };
};

/** Server-side check: plain numbers in range, known piece types, bounded size. */
export const validTrack = (value) => {
  if (value == null || typeof value !== "object" || !Array.isArray(value.pieces)) return null;
  const number = (input, min, max, fallback) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const widthMeters = number(value.widthMeters, 10, 500, DEFAULT_TRACK.widthMeters);
  const depthMeters = number(value.depthMeters, 10, 500, DEFAULT_TRACK.depthMeters);
  const pieces = value.pieces
    .slice(0, MAX_PIECES)
    .filter((piece) => PIECES[piece?.type] != null)
    .map((piece, index) => ({
      id: String(piece.id ?? `piece-${index}`).slice(0, 40),
      type: piece.type,
      x: number(piece.x, 0, widthMeters, 0),
      y: number(piece.y, 0, depthMeters, 0),
      rotation: ((number(piece.rotation, -720, 720, 0) % 360) + 360) % 360,
      order: PIECES[piece.type].course ? Math.round(number(piece.order, 1, MAX_PIECES, index + 1)) : null,
    }));
  return { widthMeters, depthMeters, gridMeters: number(value.gridMeters, 0, 10, 1), pieces };
};

import { PIECES, coursePieces } from "./track.js";

/** Draw a track top-down. `scale` is pixels per metre; `selectedId` gets the handles. */
export const drawTrack = (canvas, track, { selectedId = null, showGrid = true, ink = "#f6f1e7", muted = "#5d5346" } = {}) => {
  const context = canvas.getContext("2d");
  const scale = Math.min(canvas.width / track.widthMeters, canvas.height / track.depthMeters);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(scale, scale);
  context.lineWidth = 1 / scale;
  if (showGrid && track.gridMeters > 0) {
    context.strokeStyle = muted;
    context.globalAlpha = 0.35;
    const step = track.gridMeters * Math.max(1, Math.round(5 / (track.gridMeters * scale)));
    for (let x = 0; x <= track.widthMeters; x += step) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, track.depthMeters);
      context.stroke();
    }
    for (let y = 0; y <= track.depthMeters; y += step) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(track.widthMeters, y);
      context.stroke();
    }
    context.globalAlpha = 1;
  }
  const course = coursePieces(track);
  if (course.length > 1) {
    context.strokeStyle = ink;
    context.globalAlpha = 0.5;
    context.setLineDash([0.6, 0.6]);
    context.lineWidth = 0.15;
    context.beginPath();
    course.forEach((piece, index) => (index === 0 ? context.moveTo(piece.x, piece.y) : context.lineTo(piece.x, piece.y)));
    context.closePath();
    context.stroke();
    context.setLineDash([]);
    context.globalAlpha = 1;
  }
  for (const piece of track.pieces) {
    const spec = PIECES[piece.type];
    context.save();
    context.translate(piece.x, piece.y);
    context.rotate((piece.rotation * Math.PI) / 180);
    context.fillStyle = spec.color;
    if (piece.type === "flag" || piece.type === "cone") {
      context.beginPath();
      context.arc(0, 0, spec.width / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.fillRect(-spec.width / 2, -spec.depth / 2, spec.width, spec.depth);
      context.fillStyle = ink;
      context.beginPath();
      context.moveTo(0, -spec.depth / 2 - 0.5);
      context.lineTo(0.35, -spec.depth / 2 - 0.1);
      context.lineTo(-0.35, -spec.depth / 2 - 0.1);
      context.closePath();
      context.fill();
    }
    if (piece.id === selectedId) {
      context.strokeStyle = ink;
      context.lineWidth = 0.08;
      context.strokeRect(-spec.width / 2 - 0.3, -spec.depth / 2 - 0.3, spec.width + 0.6, spec.depth + 0.6);
      context.beginPath();
      context.moveTo(0, -spec.depth / 2 - 0.3);
      context.lineTo(0, -spec.depth / 2 - 1.6);
      context.stroke();
      context.beginPath();
      context.arc(0, -spec.depth / 2 - 1.9, 0.3, 0, Math.PI * 2);
      context.fillStyle = ink;
      context.fill();
    }
    context.restore();
    if (spec.course && piece.order != null) {
      context.fillStyle = ink;
      context.font = `${0.9}px Segoe UI`;
      context.fillText(String(piece.order), piece.x + spec.width / 2 + 0.3, piece.y - 0.3);
    }
  }
  context.restore();
  return scale;
};

/** Position of the rotate handle for a selected piece, in metres. */
export const rotateHandle = (piece) => {
  const spec = PIECES[piece.type];
  const distance = spec.depth / 2 + 1.9;
  const angle = (piece.rotation * Math.PI) / 180;
  return { x: piece.x + Math.sin(angle) * distance, y: piece.y - Math.cos(angle) * distance };
};

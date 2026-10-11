// Marker overlay drawn over a pilot's feed, after FPVTrackside's UI.Video.ArucoFrameOverlay.
import { OVERLAY_HOLD_MS } from "./aruco-timing.js";

/** ColorFor(source): Original blue, Corrected yellow, Both green. */
export const SOURCE_COLORS = Object.freeze({
  Original: "rgb(0, 0, 255)",
  Corrected: "rgb(255, 255, 0)",
  Both: "rgb(0, 255, 0)",
});

/** SetLatestDetections replaces the held set; CollectActive drops entries older than the hold. */
export class HeldDetections {
  constructor(holdMs = OVERLAY_HOLD_MS) {
    this.holdMs = holdMs;
    this.items = [];
  }

  set(detections, now = Date.now()) {
    this.items = (detections ?? [])
      .filter((detection) => detection?.corners?.length > 0)
      .map((detection) => ({ detection, seenAt: now }));
  }

  active(now = Date.now()) {
    this.items = this.items.filter((item) => now - item.seenAt <= this.holdMs);
    return this.items.map((item) => item.detection);
  }
}

/** ID and size text, as the original builds it. */
export const markerLabel = (detection, frameArea, { showId = true, showSizePercent = true } = {}) => {
  const percent = frameArea > 0 ? (detection.areaPx / frameArea) * 100 : 0;
  if (showId && showSizePercent) return `ID:${detection.id}  (${percent.toFixed(1)}%)`;
  if (showId) return `ID:${detection.id}`;
  if (showSizePercent) return `${percent.toFixed(1)}%`;
  return null;
};

const outlinedText = (ctx, text, x, y, color) => {
  ctx.lineWidth = Math.max(2, ctx.lineWidth);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
};

/**
 * Draw held detections onto a 2D canvas context sized width x height that shows the detection
 * frame (detectionWidth x detectionHeight) stretched to fit.
 */
export const drawOverlay = (ctx, view) => {
  const {
    width,
    height,
    detectionWidth,
    detectionHeight,
    detections = [],
    mirrorX = false,
    showBox = true,
    showId = true,
    showSizePercent = true,
    showFps = false,
    fps = 0,
    showSignalRatio = false,
    signalRatio = Number.NaN,
    lostSignalThreshold = 0.4,
  } = view;
  const sx = width / detectionWidth;
  const sy = height / detectionHeight;
  const unit = Math.max(1, height / 360);
  const map = (point) => ({ x: mirrorX ? width - 1 - point.x * sx : point.x * sx, y: point.y * sy });
  ctx.save();
  ctx.font = `600 ${Math.round(13 * unit)}px system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  let line = Math.round(18 * unit);
  if (showFps) {
    outlinedText(ctx, `${fps.toFixed(0)} fps`, 6 * unit, line, "rgb(255, 255, 255)");
    line += Math.round(18 * unit);
  }
  if (showSignalRatio && Number.isFinite(signalRatio)) {
    const ok = signalRatio >= lostSignalThreshold;
    outlinedText(
      ctx,
      `S ${signalRatio.toFixed(2)}/${lostSignalThreshold.toFixed(2)}`,
      6 * unit,
      line,
      ok ? "rgb(60, 255, 60)" : "rgb(255, 60, 60)",
    );
  }
  const frameArea = detectionWidth * detectionHeight;
  for (const detection of detections) {
    if (detection.corners == null || detection.corners.length < 3) continue;
    const points = detection.corners.map(map);
    const color = SOURCE_COLORS[detection.source] ?? SOURCE_COLORS.Original;
    if (showBox) {
      ctx.lineWidth = Math.max(2, Math.round(2 * unit));
      ctx.strokeStyle = color;
      ctx.beginPath();
      points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
      ctx.closePath();
      ctx.stroke();
    }
    const label = markerLabel(detection, frameArea, { showId, showSizePercent });
    if (label != null) {
      const cx = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const cy = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      ctx.lineWidth = 3;
      outlinedText(ctx, label, cx - ctx.measureText(label).width / 2, cy - 10 * unit, color);
    }
  }
  ctx.restore();
};

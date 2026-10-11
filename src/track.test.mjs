import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TRACK, addPiece, coursePieces, lapLengthMeters, moveInCourse, removePiece, snap, speedKmh, validTrack } from "../public/track.js";

const square = () => {
  let track = structuredClone(DEFAULT_TRACK);
  track = addPiece(track, "finish", 10, 10, "s");
  track = addPiece(track, "gate", 40, 10, "g1");
  track = addPiece(track, "cone", 25, 20, "c");
  track = addPiece(track, "gate", 40, 30, "g2");
  track = addPiece(track, "flag", 10, 30, "f");
  return track;
};

test("a lap runs through the course pieces in order and closes back to the start", () => {
  const track = square();
  assert.deepEqual(coursePieces(track).map((piece) => piece.id), ["s", "g1", "g2", "f"]);
  assert.equal(lapLengthMeters(track), 100);
  assert.equal(speedKmh(100, 10), 36);
  assert.equal(speedKmh(0, 10), null);
});

test("removing or reordering a course piece keeps the numbers contiguous", () => {
  const track = removePiece(square(), "g1");
  assert.deepEqual(coursePieces(track).map((piece) => [piece.id, piece.order]), [["s", 1], ["g2", 2], ["f", 3]]);
  const swapped = moveInCourse(track, "f", -1);
  assert.deepEqual(coursePieces(swapped).map((piece) => piece.id), ["s", "f", "g2"]);
  assert.equal(moveInCourse(track, "s", -1), track);
  assert.equal(snap(12.6, 0.5), 12.5);
});

test("the server keeps known pieces inside the field and drops the rest", () => {
  const cleaned = validTrack({
    widthMeters: 20,
    depthMeters: 9999,
    pieces: [
      { id: "a", type: "gate", x: 50, y: -3, rotation: 375, order: 1 },
      { id: "b", type: "rocket", x: 1, y: 1 },
      { id: "c", type: "cone", x: 2, y: 2, rotation: -90, order: 4 },
    ],
  });
  assert.equal(cleaned.depthMeters, 500);
  assert.deepEqual(cleaned.pieces, [
    { id: "a", type: "gate", x: 20, y: 0, rotation: 15, order: 1 },
    { id: "c", type: "cone", x: 2, y: 2, rotation: 270, order: null },
  ]);
  assert.equal(validTrack({ pieces: "nope" }), null);
});

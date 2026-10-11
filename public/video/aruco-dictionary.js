// OpenCV DICT_4X4_50: the first 50 rows of DICT_4X4_1000, rotation-0 bytes (16 bits, row-major,
// most significant bit first). Read from FPVTrackside's OpenCvSharpExtern.dll
// (sha256 c4aaa6233903b43b305773fb2d779ef23e814ce832e29b96791e3ac03e69f58b, file offset 0x395eb00);
// every one of the 1000 table rows there holds four rotations that agree with OpenCV's rotation rule.
const ROTATION0_BYTES = [
  [181, 50], [15, 154], [51, 45], [153, 70], [84, 158], [121, 205], [158, 46], [196, 242], [254, 218], [207, 86],
  [249, 145], [17, 167], [14, 183], [42, 15], [36, 177], [38, 62], [70, 101], [102, 0], [108, 94], [118, 175],
  [134, 139], [176, 43], [204, 213], [221, 130], [254, 71], [148, 113], [172, 228], [165, 84], [33, 35], [52, 111],
  [68, 21], [87, 178], [158, 207], [240, 203], [8, 174], [9, 41], [24, 117], [4, 255], [13, 246], [28, 90],
  [23, 24], [42, 40], [50, 140], [56, 178], [36, 232], [46, 235], [45, 63], [75, 100], [80, 46], [80, 19],
];

/** Row-major bit grid of a code, 1 = white cell. */
export const codeToBits = (code, size) =>
  Array.from({ length: size * size }, (_, index) => (code >> (size * size - 1 - index)) & 1);

export const bitsToCode = (bits) => bits.reduce((code, bit) => (code << 1) | (bit ? 1 : 0), 0);

/** OpenCV Dictionary::getByteListFromBits rotation: rot[r][c] = bits[c][size - 1 - r]. */
export const rotateBits = (bits, size) => {
  const out = new Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) out[row * size + col] = bits[col * size + (size - 1 - row)];
  }
  return out;
};

const popcount16 = (value) => {
  let v = value - ((value >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  v = (v + (v >> 4)) & 0x0f0f;
  return (v + (v >> 8)) & 0x1f;
};

const buildDictionary = (name, markerSize, maxCorrectionBits, rows) => {
  const rotations = rows.map(([high, low]) => {
    const codes = [];
    let bits = codeToBits((high << 8) | low, markerSize);
    for (let rotation = 0; rotation < 4; rotation += 1) {
      codes.push(bitsToCode(bits));
      bits = rotateBits(bits, markerSize);
    }
    return codes;
  });
  return {
    name,
    markerSize,
    // OpenCV declares DICT_4X4_50 with maxCorrectionBits 1. This value comes from OpenCV's source,
    // not from the shipped binary; at the default error-correction rate (0.6) it rounds down to 0.
    maxCorrectionBits,
    size: rows.length,
    rotations,
    bits: (id) => codeToBits(rotations[id][0], markerSize),
    /**
     * OpenCV Dictionary::identify: the first marker whose closest rotation is within the allowed
     * Hamming distance wins. Returns { id, rotation } or null.
     */
    identify(bits, errorCorrectionRate) {
      const allowed = Math.trunc(maxCorrectionBits * errorCorrectionRate);
      const candidate = bitsToCode(bits);
      for (let id = 0; id < rotations.length; id += 1) {
        let best = markerSize * markerSize + 1;
        let bestRotation = -1;
        for (let rotation = 0; rotation < 4; rotation += 1) {
          const distance = popcount16(rotations[id][rotation] ^ candidate);
          if (distance < best) {
            best = distance;
            bestRotation = rotation;
          }
        }
        if (best <= allowed) return { id, rotation: bestRotation };
      }
      return null;
    },
  };
};

export const DICT_4X4_50 = buildDictionary("DICT_4X4_50", 4, 1, ROTATION0_BYTES);

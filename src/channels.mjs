/**
 * Channel catalog recovered from FPVTrackside's RaceLib.Channel static
 * constructor and FrequencyLookup. Catalog ids are the ids RaceLib assigns,
 * so a channel keeps the same id in every event.
 */

const BAND_LETTER = {
  Fatshark: "F",
  Raceband: "R",
  A: "A",
  B: "B",
  E: "E",
  DJIFPVHD: "D",
  HDZero: "Z",
  LowBand: "L",
  Diatone: "D",
  DJIO3: "D",
  DJIO4: "D",
  WalkSnail: "W",
};

const BAND_TYPE = {
  DJIFPVHD: "DJIDigital",
  HDZero: "HDZeroDigital",
  DJIO3: "DJIO3Digital",
  DJIO4: "DJIO4Digital",
  WalkSnail: "WalkSnailDigital",
};

const BAND_TITLE = {
  Fatshark: "Fatshark",
  Raceband: "Raceband",
  A: "Boscam A",
  B: "Boscam B",
  E: "Boscam E",
  DJIFPVHD: "DJI FPV HD",
  HDZero: "HDZero",
  LowBand: "Low band",
  Diatone: "Diatone",
  DJIO3: "DJI O3",
  DJIO4: "DJI O4",
  WalkSnail: "Walksnail",
};

const row = (id, band, prefix, number, frequencyMhz) => ({
  catalogId: id,
  band,
  prefix,
  number,
  frequencyMhz,
});

const linear = (firstId, band, prefix, base, step, count = 8) =>
  Array.from({ length: count }, (_, index) =>
    row(firstId + index, band, prefix, index + 1, base + index * step),
  );

const listed = (firstId, band, prefix, frequencies) =>
  frequencies.map((frequencyMhz, index) =>
    row(firstId + index, band, prefix, index + 1, frequencyMhz),
  );

const FATSHARK = linear(1, "Fatshark", "", 5740, 20);
const RACEBAND = linear(9, "Raceband", "", 5658, 37);
const BOSCAM_A = linear(17, "A", "", 5865, -20);
const BOSCAM_B = linear(25, "B", "", 5733, 19);
const DJI_FPV_HD = listed(33, "DJIFPVHD", "", [5660, 5695, 5735, 5770, 5805, 5878, 5914, 5839]);
const BOSCAM_E = listed(41, "E", "", [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945]);
const HDZERO_RACE = linear(49, "HDZero", "R", 5658, 37);
const HDZERO_FATSHARK = [row(57, "HDZero", "F", 2, 5760), row(58, "HDZero", "F", 4, 5800)];
const LOW_BAND = linear(59, "LowBand", "", 5333, 40);
const DIATONE = linear(67, "Diatone", "", 5362, 37);
const DJI_O3 = listed(75, "DJIO3", "O", [5669, 5705, 5768, 5804, 5839, 5876, 5912]);
const HDZERO_LOW = linear(82, "HDZero", "L", 5362, 37);
const DJI_O4 = linear(100, "DJIO4", "R", 5658, 37);
const WALKSNAIL = linear(110, "WalkSnail", "R", 5658, 37);

const ALL = [
  ...FATSHARK,
  ...RACEBAND,
  ...BOSCAM_A,
  ...BOSCAM_B,
  ...DJI_FPV_HD,
  ...BOSCAM_E,
  ...HDZERO_RACE,
  ...HDZERO_FATSHARK,
  ...LOW_BAND,
  ...DIATONE,
  ...DJI_O3,
  ...HDZERO_LOW,
  ...DJI_O4,
  ...WALKSNAIL,
];

/** RaceLib.Channel.GetBandChannelText: Z for HDZero, L1 for HDZero low band, then prefix and number. */
export const shortName = (entry) => {
  if (entry.band === "HDZero" && entry.prefix === "L") return `L${entry.number}`;
  return `${BAND_LETTER[entry.band] ?? ""}${entry.prefix}${entry.number}`;
};

export const CHANNEL_CATALOG = ALL.map((entry) => ({
  ...entry,
  name: shortName(entry),
  bandTitle: BAND_TITLE[entry.band] ?? entry.band,
  bandType: BAND_TYPE[entry.band] ?? "Analogue",
}));

const byId = new Map(CHANNEL_CATALOG.map((entry) => [entry.catalogId, entry]));
export const catalogEntry = (catalogId) => byId.get(Number(catalogId)) ?? null;

const ids = (entries) => entries.map((entry) => entry.catalogId);

/** The named sets RaceLib.Channel builds, in the order a club is likely to want them. */
export const CHANNEL_PACKS = [
  { id: "raceband", title: "Raceband", detail: "Eight analogue channels 37 MHz apart. The whole pack can fly together.", ids: ids(RACEBAND) },
  { id: "imd6c", title: "IMD6C", detail: "R1, R2, F2, F4, R7, R8: six analogue channels picked to keep intermodulation low.", ids: [9, 10, 2, 4, 15, 16] },
  { id: "fatshark", title: "Fatshark", detail: "Eight analogue channels 20 MHz apart. Neighbours sit just outside the 15 MHz rule.", ids: ids(FATSHARK) },
  { id: "boscam-a", title: "Boscam A", detail: "Eight analogue channels from 5865 down to 5725 MHz.", ids: ids(BOSCAM_A) },
  { id: "boscam-b", title: "Boscam B", detail: "Eight analogue channels from 5733 to 5866 MHz, 19 MHz apart.", ids: ids(BOSCAM_B) },
  { id: "boscam-e", title: "Boscam E", detail: "Eight analogue channels at the edges of the band.", ids: ids(BOSCAM_E) },
  { id: "low-band", title: "Low band", detail: "Eight analogue channels from 5333 MHz, 40 MHz apart.", ids: ids(LOW_BAND) },
  { id: "diatone", title: "Diatone", detail: "Eight analogue channels from 5362 MHz, 37 MHz apart.", ids: ids(DIATONE) },
  { id: "dji-fpv-hd", title: "DJI FPV HD", detail: "The eight DJI FPV system channels, 5660 to 5914 MHz.", ids: ids(DJI_FPV_HD) },
  { id: "dji-o3", title: "DJI O3", detail: "Seven DJI O3 channels, 5669 to 5912 MHz.", ids: ids(DJI_O3) },
  { id: "dji-o4", title: "DJI O4", detail: "DJI O4 on the Raceband frequencies.", ids: ids(DJI_O4) },
  { id: "hdzero-race", title: "HDZero race", detail: "HDZero on the eight Raceband frequencies.", ids: ids(HDZERO_RACE) },
  { id: "hdzero-imd6c", title: "HDZero IMD6C", detail: "HDZero R1, R2, F2, F4, R7, R8.", ids: [49, 50, 57, 58, 55, 56] },
  { id: "hdzero-low", title: "HDZero low band", detail: "HDZero L1 to L8, 5362 to 5621 MHz.", ids: ids(HDZERO_LOW) },
  { id: "walksnail", title: "Walksnail", detail: "Walksnail on the Raceband frequencies.", ids: ids(WALKSNAIL) },
];

export const packById = (packId) => CHANNEL_PACKS.find((pack) => pack.id === packId) ?? null;

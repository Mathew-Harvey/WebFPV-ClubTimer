# WebFPV Club Timer

Local race desk for an FPV club. Register pilots, draw heats, and call the gate from the browser. The spectator screen shows the current heat, a lap chart, rounds, lap records, lap counts, and points.

```bash
npm start
```

Open http://127.0.0.1:8787 for the race desk and http://127.0.0.1:8787/spectator.html for the public view. The meet is stored in `data/event.json`.

The desk walks you through the meet: name it, add pilots, check channels, generate a round, then start the clock. Keys 1–8 call the gate for those seats. The first tap is the holeshot unless you turn that off. Pause holds the clock out of the next lap. Crash and DNF take a pilot out of the result.

Sessions:

- Race and game score a field of N as N, N-1, down to 1. A DNF or crash scores 0.
- Time trial and practice keep the times and leave points at zero.
- Casual practice and freestyle stay open until you close them.
- Endurance ranks by laps when the clock ends.

## Camera timing

Open http://127.0.0.1:8787/camera.html beside the desk and give each channel a video source: the pilot's video receiver through a USB capture device, a camera at the gate, a video file, or the built-in test pattern. Fix two printed ArUco markers (4x4 set, ID 0 by default; the page prints them) on the timing gate.

While a heat runs, a channel is in the gate when at least two markers each fill 0.1 % of its picture. Once they have been gone for 150 ms, the lap is recorded at the moment they vanished, and the desk's minimum lap and start window still apply. With "Mark a pilot crashed when their video stops moving" on, two seconds of still video marks a crash and three seconds of movement brings the pilot back. A `camera_calibration.json` lens calibration enables the Corrected and Hybrid passes.

These rules and defaults are FPVTrackside 2.78's, decompiled from its `Timing.dll` and `UI.dll`. The page posts to `POST /api/races/:id/detect` and `POST /api/races/:id/autocrash`.

## What came from the example installer

`clubtimerExample.msi` is FPVTrackside 2.78.0.898. REA cannot open an MSI, and the 178 MB `FPVTrackside.exe` is a .NET single-file bundle larger than REA's managed-snapshot budget. Unpacking the bundle gives its separate assemblies, which REA can inspect. The heat rules follow the installer scripts and the local web overlay: random draw, seeded snake, points groups, speed groups, A/B/C finals, chase the ace, double elimination, and triple-round elimination. Channels closer than 15 MHz stay out of the same heat.

The 3D track editor, Excel bracket files, and club-site sync stay in that desktop program.

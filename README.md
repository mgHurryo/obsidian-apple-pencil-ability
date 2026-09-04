# Apple Pencil Capability Probe

An Obsidian mobile plugin for measuring the input APIs exposed by the current WebView/WebKit environment.

## What it records

- Pointer type, coordinates, pressure, tilt, altitude, azimuth, twist, tangential pressure, size and button fields.
- `pointerrawupdate`, coalesced and predicted event availability and counts.
- Pointer enter/leave hover signals, multi-touch records and pen/touch separation.
- A capability scan of `PointerEvent.prototype`, `TouchEvent.prototype`, `window.webkit`, `window.Capacitor` and `navigator`.
- Input frequency, sampling intervals, coalesced/predicted averages, render latency and dropped-frame estimates.

The raw log is bounded at 10,000 records. The exported JSON reports whether truncation occurred.

## Development

```bash
npm install
npm run typecheck
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into an Obsidian vault plugin directory to test on iPad. Hardware-only results must be collected on the target iPad/WebView; desktop builds can verify the UI and synthetic events only.

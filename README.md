# dsh-tps

A live **tokens-per-second** card for the current DeepSeek Harness session. It
docks into the left sidebar, or floats as a draggable card — switch with the
toggle at the card's top-right corner.

## What it shows

- **Live t/s** — throughput of the streaming assistant output, computed from real
  `agent/assistant-stream` deltas (a sliding window, with a denominator floor so
  bursty chunks cannot spike the number).
- **Average t/s** — session-wide average since the first token; toggle 实时 /
  平均 (live / average) with the segmented control in the card header.
- **Sparkline** — the last 40 samples, drawn with the card's own accent colour.
- **Current task name** — left-aligned above the speed, following the card's
  selected session and remaining visible when collapsed. Long names use an
  ellipsis with the full name on hover; untitled sessions show their short ID.
- **Session list** — every session with a reading, titled and followed by the
  workspace it lives in, e.g. `dsh-tps (dsh-tps)`. Click a row to switch the card
  to that session; the click does not touch your current page.

## Dock left or float

The two buttons at the card's top-right choose the placement:

- **左侧 (left)** — dock into the sidebar footer slot. The card follows the
  sidebar: if the slot disappears (narrow window, collapsed sidebar), it falls
  back to the floating position instead of vanishing.
- **悬浮 (float)** — stay pinned as a floating card at the bottom-right corner.

The choice is remembered in `localStorage`, as are the floating position, the
collapsed state and the mode (live/average).

## Dragging

In floating mode the **whole card** is a drag handle — header, number, sparkline,
empty space. Only the buttons, the segmented controls and the session rows opt
out, because those are click targets. Drags are tracked on `document`, so the
card keeps following the pointer even when it leaves the card, and a drag never
fires the click that would toggle the card.

## Install

```sh
dsh plugin add TINGOD2006/dsh-tps
```

Then restart the harness service (the card appears in the sidebar once the plugin
is loaded). No build step, no dependencies.

## How it works

- `lib/tracker.js` keeps a per-session sliding window fed by
  `agent/assistant-stream` deltas and `session/event` (turn boundaries, cache-hit
  usage totals).
- `lib/index.js` subscribes to those events, exposes
  `GET /dsh-tps/state.json` and `GET /dsh-tps/widget.js`, and injects the card
  through **both** supported paths: the structured `webserver/index-inject` table
  (used by the Electron desktop shell) and `ctx.webServer.tapIndex()` (used when
  the Host renders `index.html` itself, e.g. `dsh web`).
- `lib/widget.js` is served from disk on every request, so editing it and
  reloading the page is enough — no restart. A `⟳` hint appears when the page is
  still running an older copy of the widget than the one on disk.

Chunks arriving in the same millisecond share one sample, retaining their full
token count during bursts. The event stream also sweeps expired trackers at most
once a minute, even without an open widget. State and update-check requests time
out after 5 seconds, including response-body reads; polling then retries normally
and slows to a 5-second interval after three consecutive failures.

## Tests

```sh
npm test
```

Covers the window denominator floor, idle decay, in-flight step readings,
block-end fallback, cache-hit accounting, burst aggregation and tracker cleanup.
Widget tests run the injected script with a lightweight DOM and a virtual clock
to verify timeout recovery, failure backoff, visibility changes and update checks.
No real waiting, network or external dependencies are needed.

## License

MIT

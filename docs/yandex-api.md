# Yandex Music API — findings (probed live 2026-07-16)

Verified against a logged-in Plus session via the browser, hitting the real API.

## Base
`https://api.music.yandex.net` — the modern JSON API used by the apps.

- Responds with permissive CORS and accepts cookies, but **cookie auth only yields the anonymous view** (limited permissions, `preview: true` streams = 30s/128kbps clips).
- Full-quality playback requires header `Authorization: OAuth <token>` where the token belongs to an account with an active Plus subscription.
- The legacy `music.yandex.ru/handlers/*.jsx` endpoints are dead (404).

## Auth model for our app
We never handle the user's password. The user supplies their **own OAuth token**
(obtained out-of-band from the official Yandex OAuth flow, client id
`23cabbbdc6cd418abb4b39c32c41195d`). Server stores it in memory and forwards it as
`Authorization: OAuth <token>`. Without a token the server runs in **demo mode**
(bundled royalty-free audio) so the whole app is testable without any credentials.

## Endpoints we use

### `GET /account/status`  → 200
`result.account` present when the token/session is valid. We use it to validate a
pasted token and to show the login.

### `GET /search?text=<q>&type=track&page=0`  → 200
`result.tracks.results[]`, each track:
```
{ id: 57703, realId: "57703", title: "Enter Sandman",
  durationMs: 331260, available: true,
  artists: [{ name: "Metallica" }],
  albums:  [{ id: 4766, title: "Metallica" }],
  coverUri: "avatars.yandex.net/get-music-content/.../%%"  }
```
Cover URL = `https://` + `coverUri.replace('%%', '200x200')` (public CDN, no auth).

### `GET /tracks/<id>/download-info`  → 200
Returns an array of variants:
```
[{ bitrateInKbps: 320, codec: "mp3", direct: false,
   downloadInfoUrl: "https://storage.mds.yandex.net/download-info/...", preview: false }]
```
Anonymous session only returns `preview: true` variants.

### Streaming sign flow (server-side)
1. Pick the best `codec: "mp3"` variant, `GET` its `downloadInfoUrl` → XML:
   `<download-info><host>..</host><path>/..</path><ts>..</ts><s>..</s></download-info>`
2. `sign = md5("XGRlBW9FXlekgbPrRHuSiA" + path.slice(1) + s)`
3. Final audio URL = `https://<host>/get-mp3/<sign>/<ts><path>`
4. Server streams those bytes back to the client (with Range support) at `/api/stream/:id`.

## "Моя волна" / My Wave — rotor API (probed 2026-07-16)
Personalized AI radio. **Requires the OAuth token** — the anonymous cookie session
cannot resolve the user (`400 "Cannot build either user id"`; `session/new` → `401`).
So this is a yandex-mode-only feature with a demo-mode simulation fallback.

Two flows exist; we use the **legacy station flow** (single GET, stable, easy to page):
- `GET /rotor/station/user:onyourwave/tracks?settings2=true` → `result.sequence[]`,
  each item `{ type, track: <full track obj>, liked }`, plus `result.batchId`.
- Advance the wave by passing the last reached track:
  `GET /rotor/station/user:onyourwave/tracks?settings2=true&queue=<lastTrackId>`.
- Feedback (best-effort, makes the model adapt) —
  `POST /rotor/station/user:onyourwave/feedback` with
  `{ "event": "radioStarted"|"trackStarted"|"trackFinished"|"skip", "trackId": "..",
     "batchId": "..", "totalPlayedSeconds": <n> }`.
The dashboard `GET /rotor/stations/dashboard` works anonymously (station list only).

## Playlists (probed 2026-07-16, needs the OAuth token; uid from account/status)
- List the user's playlists: `GET /users/<uid>/playlists/list` →
  `result[]`, each `{ kind, title, trackCount, ... }` (kind is the playlist id).
- One playlist with tracks: `GET /users/<uid>/playlists/<kind>` →
  `result.title`, `result.trackCount`, `result.tracks[]` where each item is
  `{ id, originalIndex, timestamp, track: <full track obj>, ... }`.
- Liked tracks: `GET /users/<uid>/likes/tracks` → `result.library.tracks[]`,
  each `{ id, albumId, timestamp }` — **ids only**. Resolve full metadata in
  batches via `GET /tracks?track-ids=<id1,id2,...>` → `result[]` full tracks.
- `uid` comes from `GET /account/status` → `result.account.uid`.

## Our server contract (what the client sees) — see `shared/types.ts`
```
GET  /api/status                 → StatusResponse
POST /api/token   {token}        → TokenResponse | 401 ApiError
GET  /api/search?q=<text>        → SearchResponse   (demo: all demo tracks when q empty)
GET  /api/stream/:id             → audio/mpeg bytes, Accept-Ranges: bytes
GET  /api/wave?after=<trackId>   → WaveResponse     (My Wave next batch; demo: simulated)
POST /api/wave/feedback {..}     → 204              (rotor feedback; no-op in demo)
GET  /api/playlists              → PlaylistsResponse (user's playlists; demo: from catalog)
GET  /api/playlists/:id/tracks   → PlaylistTracksResponse
```

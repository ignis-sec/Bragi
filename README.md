# Muse

Disposable music, generated on the fly, completely locally. A Qwen model (via LM Studio) writes song metadata + lyrics, MiniMax-music-3 (via ComfyUI) renders the audio, and a Spotify-style dashboard plays the endless queue.

## How the loop works

```
┌─> free ComfyUI VRAM (POST /free — unload cached models)
│      │
│   Qwen tops the draft queue up to 3 songs (LM Studio, tool call submit_song)
│      │
│   unload Qwen (free VRAM)
│      │
│   ComfyUI renders the oldest draft (MiniMax Music 3)   <── user edits the other drafts meanwhile
│      │
└── finished song lands in the queue, saved as songs/<Song Name>.mp3
```

Each side of the pipeline evicts the other before loading: ComfyUI's cached models are freed before the LM Studio routine (with a short settle wait for the VRAM to actually return), and Qwen is unloaded before rendering. All drafts are written **before** a render starts, so the GPU never runs both models at once — and during the whole audio render every remaining draft stays editable in the dashboard. A draft's edits are locked in the moment it's handed to ComfyUI.

## Requirements

- **Node.js 18+**
- **LM Studio** serving on `http://127.0.0.1:1234` with `qwen/qwen3.6-35b-a3b` available (`lms server start`). The `lms` CLI should be on your PATH — it's used to unload the model between steps.
- **ComfyUI** on `http://127.0.0.1:8188` with the MiniMax Music 3 nodes and models installed (see `audio_minimax_music_3.json`).

## Setup & run

```bash
npm run setup    # installs server + web dependencies
npm run build    # builds the React frontend
npm start        # serves everything on http://localhost:7700
```

For frontend development: `npm run dev` (server on :7700, Vite dev server with hot reload on :5173).

Open the dashboard, optionally fill in guidance (genre, BPM, mood, …), and flip the **Generation loop** switch. Once the first song lands in the queue, press play — from then on the queue auto-advances.

## Configuration — `config.json`

| Key | Meaning |
| --- | --- |
| `lmstudio.baseUrl` / `model` | LM Studio endpoint and model id |
| `lmstudio.unload` | `"cli"` (run `lms unload --all`), `"ttl"` (rely on the per-request TTL only), or `"none"` |
| `lmstudio.ttlSeconds` | JIT TTL sent with each request as a fallback auto-unload |
| `comfyui.baseUrl` / `workflow` | ComfyUI endpoint and workflow template (with `${caption}` / `${lyrics}` placeholders) |
| `comfyui.freeWaitMs` | How long to wait after `POST /free` for VRAM to actually come back |
| `generation.maxQueuedSongs` | The loop pauses when this many unplayed songs are queued |
| `generation.draftLookahead` | How many drafts Qwen writes ahead (default 3) |
| `storage.songsDir` | Folder where finished songs are saved, named `<Song Name>.mp3` |
| `server.port` | Dashboard/API port |

The Qwen system prompt lives in `server/prompts/system-prompt.md` — edit it freely; it's read fresh on every generation.

If your LM Studio server requires an API key, put it in a `.env` file at the project root (see `.env.example`): `LLM_API_KEY=...`. It's sent as an `Authorization: Bearer` header on chat requests; a real environment variable with the same name takes precedence over `.env`.

> **Note:** `sample.txt` in this repo was empty at build time, so the caption/lyrics format in the system prompt follows the common conventions for this class of music models (comma-separated tag caption; `[verse]`/`[chorus]`-tagged lyrics). If your sample uses a different format, adjust `server/prompts/system-prompt.md` accordingly.

## Dashboard

- **Generation loop** toggle + live engine status (writing / unloading / rendering / errors).
- **Autoplay** toggle — starts playback automatically when a song lands in the queue and nothing is playing.
- **Pad from bookmarks** toggle — when a song finishes and the queue is empty, plays a random bookmarked song instead of going silent.
- **Guidance panel** — genre, BPM, mood, instruments, vocal type, language, free-form instructions. Applied to every song Qwen writes next.
- **Up next panel** — the queue of drafts Qwen has already written (3 by default), each expandable and editable until it's dispatched. Per-draft **Rewrite** asks Qwen for a different song (note: this loads the LLM even if ComfyUI is mid-render); the ✕ discards a draft.
- **In the studio card** — shows the song ComfyUI is currently rendering with elapsed time, and a **Cancel** button that interrupts the render and discards the half-made song (the loop moves straight on to the next draft).
- **Queue** — rendered songs waiting to play; auto-advances, removable.
- **Now playing** — cover art, caption, full lyrics.
- **Download** — every song row and the player bar have a download button for the mp3.
- **History** — every finished/skipped play with timestamps.
- **Bookmarks** — heart a song while it plays (player bar or any song row) to keep it out of the disposable churn; deletable with its audio file.

## Storage

Finished songs are saved to `songs/<Song Name>.mp3` (configurable via `storage.songsDir`); the library/queue/history/settings live in `data/db.json`. Files from the old `data/audio/<uuid>.mp3` layout are migrated and renamed automatically on startup. Delete both to start fresh.

## API (all local)

`GET /api/state` · `GET /api/events` (SSE) · `POST /api/loop {enabled}` · `POST /api/generating/cancel` · `PATCH /api/settings` · `PATCH /api/guidance` · `PATCH /api/drafts/:id` · `POST /api/drafts/:id/regenerate` · `DELETE /api/drafts/:id` · `POST /api/songs/:id/played` · `POST /api/songs/:id/bookmark` · `POST /api/queue/:id/remove` · `DELETE /api/songs/:id` · `GET /audio/<file>`

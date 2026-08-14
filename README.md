# Muse

Disposable music, generated on the fly, completely locally. A Qwen model (via LM Studio) writes song metadata + lyrics, MiniMax-music-3 (via ComfyUI) renders the audio, and a Spotify-style dashboard plays the endless queue.

## How the loop works

```
┌─> free ComfyUI VRAM (POST /free — unload cached models)
│      │
│   Qwen writes song N+1 (LM Studio, tool call submit_song)
│      │
│   unload Qwen (free VRAM)
│      │
│   ComfyUI renders song N (MiniMax Music 3)   <── user edits song N+1 meanwhile
│      │
└── song N lands in the queue
```

Each side of the pipeline evicts the other before loading: ComfyUI's cached models are freed before the LM Studio routine, and Qwen is unloaded before rendering. The next draft is always written **before** the current song is dispatched to ComfyUI, so the GPU never runs both models at once — and during the whole audio render you can edit the *next* song's name, caption, and lyrics from the dashboard. Edits are locked in the moment the draft is handed to ComfyUI.

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
| `generation.maxQueuedSongs` | The loop pauses when this many unplayed songs are queued |
| `server.port` | Dashboard/API port |

The Qwen system prompt lives in `server/prompts/system-prompt.md` — edit it freely; it's read fresh on every generation.

If your LM Studio server requires an API key, put it in a `.env` file at the project root (see `.env.example`): `LLM_API_KEY=...`. It's sent as an `Authorization: Bearer` header on chat requests; a real environment variable with the same name takes precedence over `.env`.

> **Note:** `sample.txt` in this repo was empty at build time, so the caption/lyrics format in the system prompt follows the common conventions for this class of music models (comma-separated tag caption; `[verse]`/`[chorus]`-tagged lyrics). If your sample uses a different format, adjust `server/prompts/system-prompt.md` accordingly.

## Dashboard

- **Generation loop** toggle + live engine status (writing / unloading / rendering / errors).
- **Guidance panel** — genre, BPM, mood, instruments, vocal type, language, free-form instructions. Applied to every song Qwen writes next.
- **Up next editor** — shows the song that will be generated *after* the current render, editable until it's dispatched. **Rewrite** asks Qwen for a fresh draft (note: this loads the LLM even if ComfyUI is mid-render).
- **Queue** — rendered songs waiting to play; auto-advances, removable.
- **Now playing** — cover art, caption, full lyrics.
- **History** — every finished/skipped play with timestamps.
- **Bookmarks** — heart a song while it plays (player bar or any song row) to keep it out of the disposable churn; deletable with its audio file.

## Storage

Generated audio and the library live in `data/` (`data/audio/*.mp3`, `data/db.json`). Delete the folder to start fresh.

## API (all local)

`GET /api/state` · `GET /api/events` (SSE) · `POST /api/loop {enabled}` · `PATCH /api/guidance` · `PATCH /api/draft` · `POST /api/draft/regenerate` · `POST /api/songs/:id/played` · `POST /api/songs/:id/bookmark` · `POST /api/queue/:id/remove` · `DELETE /api/songs/:id` · `GET /audio/<file>`

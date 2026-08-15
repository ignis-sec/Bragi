# Bragi

Disposable music, generated on the fly, completely locally. Bragi — a local LLM served via LM Studio or llama.cpp — writes song metadata + lyrics, MiniMax-music-3 (via ComfyUI) renders the audio, and a Spotify-style dashboard plays the endless queue.

## How the loop works

```
┌─> free ComfyUI VRAM (POST /free — unload cached models)
│      │
│   Bragi refills the draft pool to lookahead + 1 (LM Studio, tool call submit_song)
│      │
│   unload the songwriter LLM (free VRAM)
│      │
│   ComfyUI renders the oldest draft (MiniMax Music 3)   <── user edits the other drafts meanwhile
│      │
└── finished song lands in the queue, saved as songs/<Song Name>.mp3
```

Each side of the pipeline evicts the other before loading: ComfyUI's cached models are freed before the LM Studio routine (with a short settle wait for the VRAM to actually return), and the songwriter LLM is unloaded before rendering. All drafts are written **before** a render starts, so the GPU never runs both models at once — and during the whole audio render every remaining draft stays editable in the dashboard. A draft's edits are locked in the moment it's handed to ComfyUI.

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
| `llm.backend` | `"lmstudio"` or `"llamacpp"` — who runs the songwriter (see below) |
| `llamacpp.*` | llama-server binary, GGUF path, port, ctx, extra args, and the `jlens` block |
| `lmstudio.baseUrl` / `model` | LM Studio endpoint and model id |
| `lmstudio.unload` | `"cli"` (run `lms unload --all`), `"ttl"` (rely on the per-request TTL only), or `"none"` |
| `lmstudio.ttlSeconds` | JIT TTL sent with each request as a fallback auto-unload |
| `comfyui.baseUrl` / `workflow` | ComfyUI endpoint and workflow template (with `${caption}` / `${lyrics}` placeholders) |
| `comfyui.freeWaitMs` | How long to wait after `POST /free` for VRAM to actually come back |
| `generation.maxQueuedSongs` | The loop pauses when this many unplayed songs are queued |
| `generation.draftLookahead` | How many drafts stay waiting/editable while a render runs (default 3). The pool is refilled to this size + 1 every time a render finishes, however many are missing |
| `generation.recentSongsInPrompt` | List recent songs in the prompt with a "write something clearly different" instruction (default on; toggle in Settings) |
| `storage.songsDir` | Folder where finished songs are saved, named `<Song Name>.mp3` |
| `server.port` | Dashboard/API port |

Bragi's system prompt lives in `server/prompts/system-prompt.md` — edit it freely; it's read fresh on every generation.

## Songwriter backends

`llm.backend` selects who serves Bragi (the songwriter LLM):

- **`"lmstudio"`** (default) — the external LM Studio server, exactly as before.
- **`"llamacpp"`** — Bragi spawns its own `llama-server` per writing session and kills it afterwards (which doubles as the VRAM handoff to ComfyUI). Set `llamacpp.model` to your GGUF path and `llamacpp.extraArgs` to your usual llama.cpp flags (e.g. `["-ngl", "99", "--n-cpu-moe", "40"]` to keep MoE experts in RAM on a 16 GB card). `llamacpp.serverBin` points at the binary — built locally from source with CUDA:

  ```bash
  git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
  cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER=/usr/local/cuda/bin/nvcc \
        -DCMAKE_CUDA_ARCHITECTURES=120 -DLLAMA_CURL=OFF   # 120 = RTX 5080 (Blackwell)
  cmake --build build --config Release --target llama-server -j
  ```
  (`-DCMAKE_CUDA_COMPILER` matters on Ubuntu: CMake otherwise picks apt's old `/usr/bin/nvcc`, which fails against gcc 13.) Server logs land in `data/llama-server.log`.

## j-lens concept injection (llamacpp backend only)

With `llamacpp.jlens.enabled`, each writing session injects 1–2 concepts directly into the model's residual stream while it writes, via a control vector derived from a fitted [Jacobian lens](https://github.com/anthropics/jacobian-lens): for concept word *w* and lens Jacobian `J_l`, the injected direction solves `J_l x ≈ u_w` (ridge-regularized), i.e. "the layer-l direction whose average forward effect is *saying w*".

One-time setup:

```bash
uv venv tools/.venv && uv pip install --python tools/.venv/bin/python -r tools/requirements.txt
tools/.venv/bin/python tools/jlens_precompute.py \
    --lens /path/to/lens.pt --out data/jlens/deck.npz
```

`jlens_precompute.py` fetches only the tokenizer and the needed `lm_head` rows from the HF model repo (KBs, via range requests) and solves pullback vectors for every word in `tools/jlens_wordlist.txt` (~150 curated concept words — edit it, then re-run). It also writes `deck-ainv.npy`, a ~640 MB per-layer solver cache. Use `--inspect` to dump the lens file structure if loading fails.

**The deck is self-healing**: pin a concept that isn't in the deck and the server solves it on the fly (`jlens_make_cv.py --auto-add` → one small HF fetch + cached solves, a few seconds) and appends it to the deck permanently. Words added this way are pinned-only — they don't join the random rotation unless you also add them to the wordlist. Manual equivalent: `jlens_precompute.py --lens … --out data/jlens/deck.npz --add gasoline,asphalt`.

Injection is **opt-in per session**: with the dashboard's **Concept seeds** field empty, songs generate untouched. Pin concepts (`ocean, rust:0.2` — strengths optional) or type the literal word `random` to draw `conceptsPerSession` words from the wordlist; Bragi then builds `data/jlens/current.gguf` via `tools/jlens_make_cv.py` and passes it to llama-server as `--control-vector`. Knobs in `llamacpp.jlens`: `conceptsPerSession`, `strengthRange` (random per-concept strength), `layerRange` (which lens layers to inject), `mentionInPrompt` (also name the concepts in the prompt). Concepts appear as chips on drafts and in the engine status ("Injecting: ocean ×0.25").

**Calibration (measured on this model):** injection strength compounds across layers, and the dose–response ramp is steep. On the mid band (layers 12–20), ~**0.15–0.3** per concept flavors the song's imagery while staying coherent (the shipped default); ~0.5 degrades structure; on the wide band (8–30) use ~0.05–0.12 instead. Anything near 1+ makes the model literally chant the concept word. If a draft comes out as word salad, the status chips tell you which concepts/strengths to dial down.

On the lmstudio backend, pinned Concept seeds still work as prompt-level seeds (no injection).

**Sparse semantic noise** (sidebar toggle) adds a second, independent control vector per song: K random common words from the *full* vocabulary (~tens of thousands of candidates), blended with random positive weights into one pulled-back direction — a different meaning-bearing "dream tilt" every session, unlike isotropic noise which is near-orthogonal to every feature and does nothing at safe norms. Composes with concept injection (llama.cpp sums multiple `--control-vector` files). The roll is **re-randomized for every song**: since control vectors are fixed at process start, Bragi rebuilds `noise.gguf` and restarts the (warm) llama-server between drafts — a few seconds each. Tune blend size and strength in Settings (`llamacpp.jlens.noise.tokens` / `.strength`); the current roll shows live in the sidebar status and is stored on each draft/song. First use downloads and caches the full unembedding matrix (`data/jlens/lm-head.npy`, ~1 GB, one-time) so later sessions are fully local.

If your LM Studio server requires an API key, put it in a `.env` file at the project root (see `.env.example`): `LLM_API_KEY=...`. It's sent as an `Authorization: Bearer` header on chat requests; a real environment variable with the same name takes precedence over `.env`.

> **Note:** the caption/lyrics format in the system prompt follows `sample.txt`: a rich prose caption with `Global Metadata:` / `Vocal Details:` / `Arrangement:` paragraphs, and Title Case section tags (`[Verse 1]`, `[Chorus]`, `[Guitar solo]`…) in the lyrics.

## Dashboard

- **Generation loop** toggle + live engine status (writing / unloading / rendering / errors).
- **Autoplay** toggle — starts playback automatically when a song lands in the queue and nothing is playing.
- **Pad from bookmarks** toggle — when a song finishes and the queue is empty, plays a random bookmarked song instead of going silent.
- **Guidance panel** — genre, BPM, mood, instruments, vocal type, language, free-form instructions. Applied to every song Bragi writes next.
- **Up next panel** — the queue of drafts Bragi has already written (3 by default), each expandable and editable until it's dispatched. Per-draft **Rewrite** asks Bragi for a different song (note: this loads the LLM even if ComfyUI is mid-render); the ✕ discards a draft. **+ Custom song** adds your own hand-written entry (marked `custom`; it won't be sent to ComfyUI while caption or lyrics are empty — `incomplete` badge). Drag the ☰ handle to reorder the queue.
- **In the studio card** — shows the song ComfyUI is currently rendering with elapsed time, and a **Cancel** button that interrupts the render and discards the half-made song (the loop moves straight on to the next draft).
- **Queue** — rendered songs waiting to play; auto-advances, removable.
- **Now playing** — cover art, caption, full lyrics.
- **Download** — every song row and the player bar have a download button for the mp3.
- **Album art** toggle — while the pipeline is idle (queue full, loop off, or waiting), Bragi generates real cover art for bookmarked songs: Bragi (as an art director, `server/prompts/cover-prompt.md`) imagines what the cover *depicts* — a concrete visual scene, never "an album cover for…" — and ComfyUI renders it via `album_cover.json` (`$prompt` placeholder, `covers.workflow` in config). Covers land in `data/covers/` and replace the gradient placeholder everywhere the song appears. The cover engine holds the GPU only while the main loop is parked and yields the moment the queue drains; image prompts are cached per song so an interrupted batch resumes without the LLM.
- **History** — every finished/skipped play with timestamps.
- **Bookmarks** — heart a song while it plays (player bar or any song row) to keep it out of the disposable churn; deletable with its audio file. Each bookmarked song has a **reroll cover** button (↻) that discards the current art *and* its cached image prompt, so Bragi re-imagines the cover from scratch on the next idle window.

## Settings page

The **Settings** view (gear icon) edits everything live: songwriter backend and sampling (temperature, top_p, top_k, min_p, repeat_penalty for both backends), LM Studio / llama.cpp connection details, j-lens defaults (strength range, injection layer range, per-session concept count), ComfyUI connection, music generation parameters (max duration, diffusion steps, both CFG values, sampler, scheduler, encode top_k, and the three model filenames), queue/lookahead sizes, and the full songwriter system prompt.

The **Logging tab** toggles debug log categories — `engine` (loop lifecycle), `prompts` (full LLM prompts), `llmResponses` (raw responses + token usage), `comfy` (dispatches/renders/VRAM frees), `jlens` (concept picks, control-vector builds), `llamacpp` (server spawn/health), `http` (dashboard API calls with bodies) — and shows a live, filterable viewer of the last 500 entries (pause/clear, expandable payloads). Logs also go to the server console and optionally `data/muse.log`. Category toggles hot-apply like any other setting.

Changes write back to `config.json` and **hot-apply**: the engine reads config at use-time and creates a fresh songwriter session each cycle, so everything takes effect on the next writing session or render — except `server.port` and `storage.songsDir`, which are flagged in the UI as needing a restart. Music parameters are stored as `comfyui.workflowOverrides` and applied to the workflow at dispatch time (matched by node `class_type`), so your exported `audio_minimax_music_3.json` stays pristine as a template; blank override fields fall back to the template's values.

## Storage

All live state and settings live in **`data/bragi.db`** (SQLite, via Node's built-in `node:sqlite`): the song library, queue, history, drafts, guidance, dashboard toggles, and every settings-page change (stored as dotted-path overrides). **`config.json` is defaults only — the app never writes it**; edit it to change what a fresh database starts from, and use the Settings page for live values.

Finished songs are saved to `songs/<Song Name>.mp3` (configurable via `storage.songsDir`), covers to `data/covers/`. On first boot after the upgrade, the old `data/db.json` is imported automatically (renamed to `db.json.migrated`) — except album art, which is dropped and regenerated by the cover engine with the current art-director pipeline. Files from the old `data/audio/<uuid>.mp3` layout are still migrated and renamed on startup. Delete `data/bragi.db` to start fresh.

## API (all local)

`GET /api/state` · `GET /api/events` (SSE) · `GET|PATCH /api/config` (dotted-path map, e.g. `{"lmstudio.temperature": 0.8}`) · `GET|PUT /api/system-prompt` · `GET /api/logs?since=<id>` · `POST /api/logs/clear` · `POST /api/loop {enabled}` · `POST /api/generating/cancel` · `PATCH /api/settings` · `PATCH /api/guidance` · `PATCH /api/drafts/:id` · `POST /api/drafts/:id/regenerate` · `DELETE /api/drafts/:id` · `POST /api/songs/:id/played` · `POST /api/songs/:id/bookmark` · `POST /api/queue/:id/remove` · `DELETE /api/songs/:id` · `GET /audio/<file>`

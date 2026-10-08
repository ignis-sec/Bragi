#!/usr/bin/env python3
"""Precompute j-lens concept pullback vectors ("the deck").

For each word w and each lens layer l, solves the regularized least-squares
problem

    J_l x  ~=  u_w        (u_w = the word's unembedding row)

so that x is the layer-l residual direction whose average forward effect —
according to the Jacobian lens J_l = E[dh_final/dh_l] — is "say w". The unit-
normalized x vectors are stored per (word, layer) in a .npz deck that
jlens_make_cv.py combines into llama.cpp control-vector GGUF files.

Only the lm_head rows for the wordlist tokens are needed, so they are fetched
with HTTP range requests from the HuggingFace model repo (a few KB per word)
instead of downloading a full weights shard. The tokenizer is cached next to
the deck.

Full build (also writes <deck>-ainv.npy, the cached per-layer solver, so
incremental adds later take seconds):
  jlens_precompute.py --lens lens.pt --out data/jlens/deck.npz \
      [--hf-model Qwen/Qwen3.6-35B-A3B] [--wordlist tools/jlens_wordlist.txt] \
      [--ridge 0.05] [--inspect]

Incremental add (self-healing path; appends to an existing deck):
  jlens_precompute.py --lens lens.pt --out data/jlens/deck.npz --add gasoline,asphalt

Offline/testing overrides:
  --lm-head-file FILE.safetensors   local safetensors with lm_head.weight
  --tokenizer-file FILE.json        tokenizers-format file, or a plain
                                    {"word": id} JSON map (testing)
"""

import argparse
import json
import os
import re
import struct
import sys
import urllib.error
import urllib.request

import numpy as np
import torch

HF_BASE = "https://huggingface.co/{repo}/resolve/main/{file}"


def log(*args):
    print("[jlens-precompute]", *args, flush=True)


def ainv_path_for(deck_path):
    return re.sub(r"\.npz$", "", deck_path) + "-ainv.npy"


def atomic_save(path, save_fn):
    tmp = path + ".tmp"
    save_fn(tmp)
    os.replace(tmp, path)


# ---------------------------------------------------------------- lens loading


def load_lens_jacobians(path, inspect=False):
    """Return {layer_index: np.float32 (d, d)} from a jlens lens.pt file."""
    try:
        obj = torch.load(path, map_location="cpu", weights_only=True)
    except Exception as err:
        log(f"weights_only load failed ({err}); retrying with weights_only=False")
        obj = torch.load(path, map_location="cpu", weights_only=False)

    if inspect:
        _inspect(obj)
        sys.exit(0)

    jac = _extract_jacobians(obj)
    if not jac:
        raise SystemExit(
            "Could not find per-layer square Jacobian matrices in the lens file. "
            "Run with --inspect to see its structure, then adapt _extract_jacobians()."
        )
    d = next(iter(jac.values())).shape[0]
    log(f"lens: {len(jac)} layers ({min(jac)}..{max(jac)}), d_model={d}")
    return jac


def _inspect(obj, prefix="", depth=0):
    pad = "  " * depth
    if torch.is_tensor(obj):
        print(f"{pad}{prefix}: tensor {tuple(obj.shape)} {obj.dtype}")
    elif isinstance(obj, dict):
        print(f"{pad}{prefix}: dict ({len(obj)} keys)")
        for k, v in list(obj.items())[:60]:
            _inspect(v, str(k), depth + 1)
    elif isinstance(obj, (list, tuple)):
        print(f"{pad}{prefix}: {type(obj).__name__} ({len(obj)} items)")
        for i, v in enumerate(obj[:8]):
            _inspect(v, f"[{i}]", depth + 1)
    else:
        print(f"{pad}{prefix}: {type(obj).__name__}")
        attrs = getattr(obj, "__dict__", None)
        if attrs and depth < 4:
            for k, v in list(attrs.items())[:60]:
                _inspect(v, k, depth + 1)


def _extract_jacobians(obj):
    found = {}

    def visit(node, key_hint):
        if torch.is_tensor(node):
            if node.ndim == 2 and node.shape[0] == node.shape[1] and node.shape[0] >= 64:
                m = re.search(r"(\d+)\s*$", key_hint or "")
                if m:
                    found[int(m.group(1))] = node
            elif node.ndim == 3 and node.shape[1] == node.shape[2] and node.shape[1] >= 64:
                for i in range(node.shape[0]):
                    found[i] = node[i]
            return
        if isinstance(node, dict):
            for k, v in node.items():
                visit(v, str(k))
        elif isinstance(node, (list, tuple)):
            for i, v in enumerate(node):
                visit(v, f"{key_hint}.{i}" if key_hint else str(i))
        elif hasattr(node, "__dict__"):
            for k, v in vars(node).items():
                visit(v, k)

    visit(obj, "")
    return {l: t.to(torch.float32).numpy() for l, t in found.items()}


# ------------------------------------------------------- tokenizer & lm_head


def http_get(url, byte_range=None):
    req = urllib.request.Request(url, headers={"User-Agent": "bragi-jlens/0.1"})
    if byte_range is not None:
        req.add_header("Range", f"bytes={byte_range[0]}-{byte_range[1]}")
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def word_token_ids(words, repo, tokenizer_file, cache_dir=None):
    """Map each word to its leading token id (with a leading space)."""
    cache = os.path.join(cache_dir, "tokenizer.json") if cache_dir else None
    if tokenizer_file:
        raw = open(tokenizer_file, "rb").read()
    elif cache and os.path.exists(cache):
        raw = open(cache, "rb").read()
    else:
        log("fetching tokenizer.json ...")
        raw = http_get(HF_BASE.format(repo=repo, file="tokenizer.json"))
        if cache:
            atomic_save(cache, lambda p: open(p, "wb").write(raw))
    data = json.loads(raw)
    if "model" not in data:  # plain {"word": id} map (testing convenience)
        missing = [w for w in words if w not in data]
        if missing:
            raise SystemExit(f"words missing from vocab map: {missing}")
        return {w: int(data[w]) for w in words}

    from tokenizers import Tokenizer

    tok = Tokenizer.from_str(raw.decode("utf-8"))
    ids = {}
    for w in words:
        enc = tok.encode(" " + w, add_special_tokens=False)
        if not enc.ids:
            raise SystemExit(f"tokenizer produced no ids for {w!r}")
        ids[w] = enc.ids[0]
    return ids


def fetch_lm_head_rows(token_ids, repo, lm_head_file):
    """Return ({token_id: np.float32 (d,)}, d) for the requested rows."""
    tensor_names = ("lm_head.weight", "model.embed_tokens.weight")

    if lm_head_file:
        raw = open(lm_head_file, "rb").read()
        header_len = struct.unpack("<Q", raw[:8])[0]
        header = json.loads(raw[8 : 8 + header_len])
        entry, name = _find_entry(header, tensor_names)
        data_start = 8 + header_len

        def read_bytes(a, b):
            return raw[a : b + 1]

    else:
        log("locating lm_head shard ...")
        try:
            index = json.loads(http_get(HF_BASE.format(repo=repo, file="model.safetensors.index.json")))
            weight_map = index["weight_map"]
            name = next(n for n in tensor_names if n in weight_map)
            shard = weight_map[name]
        except urllib.error.HTTPError:
            shard = "model.safetensors"  # unsharded repo
        url = HF_BASE.format(repo=repo, file=shard)
        header_len = struct.unpack("<Q", http_get(url, (0, 7)))[0]
        header = json.loads(http_get(url, (8, 8 + header_len - 1)))
        entry, name = _find_entry(header, tensor_names)
        data_start = 8 + header_len

        def read_bytes(a, b):
            return http_get(url, (a, b))

    dtype = entry["dtype"]
    vocab, d = entry["shape"]
    t_start = data_start + entry["data_offsets"][0]
    bytes_per = {"F16": 2, "BF16": 2, "F32": 4}[dtype]
    row_bytes = d * bytes_per
    log(f"unembedding: {name} [{vocab}, {d}] {dtype}")

    rows = {}
    for tid in sorted(set(token_ids)):
        if tid >= vocab:
            raise SystemExit(f"token id {tid} out of range for vocab {vocab}")
        off = t_start + tid * row_bytes
        buf = read_bytes(off, off + row_bytes - 1)
        if dtype == "F16":
            row = np.frombuffer(buf, dtype=np.float16).astype(np.float32)
        elif dtype == "F32":
            row = np.frombuffer(buf, dtype=np.float32).copy()
        else:  # BF16: widen each u16 into the high half of a u32, view as f32
            u32 = np.frombuffer(buf, dtype=np.uint16).astype(np.uint32) << 16
            row = u32.view(np.float32)
        rows[tid] = row
    return rows, d


def _find_entry(header, tensor_names):
    for n in tensor_names:
        if n in header:
            return header[n], n
    raise SystemExit(f"none of {tensor_names} found in safetensors header")


# -------------------------------------------------------------------- solving


def unembed_matrix(words, repo, tokenizer_file, lm_head_file, cache_dir, d_expected):
    """Unit-normalized unembedding directions as (d, W) for `words`."""
    ids = word_token_ids(words, repo, tokenizer_file, cache_dir=cache_dir)
    rows, d_head = fetch_lm_head_rows(list(ids.values()), repo, lm_head_file)
    if d_expected is not None and d_head != d_expected:
        raise SystemExit(f"d_model mismatch: lens {d_expected} vs unembedding {d_head}")
    U = np.stack([rows[ids[w]] for w in words], axis=1)
    U /= np.linalg.norm(U, axis=0, keepdims=True) + 1e-8
    return U


def solve_deck(jac, layers, U, ridge, ainv_stack=None, collect_ainv=False):
    """Solve pullbacks for all layers. Returns (vectors (W,L,d), ainv or None)."""
    d = jac[layers[0]].shape[0]
    W = U.shape[1]
    vectors = np.zeros((W, len(layers), d), dtype=np.float32)
    collected = np.zeros((len(layers), d, d), dtype=np.float32) if collect_ainv else None
    for li, layer in enumerate(layers):
        J = jac[layer]
        if ainv_stack is not None:
            X = ainv_stack[li] @ (J.T @ U)
        else:
            A = J.T @ J
            lam = ridge * np.trace(A) / d
            A[np.diag_indices_from(A)] += lam
            if collect_ainv:
                Ainv = np.linalg.inv(A)
                collected[li] = Ainv
                X = Ainv @ (J.T @ U)
            else:
                X = np.linalg.solve(A, J.T @ U)
        X /= np.linalg.norm(X, axis=0, keepdims=True) + 1e-8
        vectors[:, li, :] = X.T
        log(f"layer {layer}: solved {W} pullbacks")
    return vectors, collected


def save_deck(path, words, layers, vectors, meta):
    # Write via an open handle: keeps the write atomic (np.savez would append
    # ".npz" to a bare temp filename and break the rename).
    atomic_save(
        path,
        lambda p: np.savez_compressed(
            open(p, "wb"), words=np.array(words), layers=np.array(layers, dtype=np.int32),
            vectors=vectors, meta=json.dumps(meta),
        ),
    )
    log(f"deck saved: {path} ({vectors.nbytes / 1e6:.0f} MB uncompressed, {len(words)} words)")


# Importable by jlens_make_cv.py for --auto-add. Appends solved vectors for
# `new_words` to an existing deck; uses the cached solver when available.
def add_words_to_deck(deck_path, lens_path, hf_model, new_words,
                      tokenizer_file=None, lm_head_file=None):
    deck = np.load(deck_path, allow_pickle=False)
    words = [str(w) for w in deck["words"]]
    layers = [int(l) for l in deck["layers"]]
    vectors = deck["vectors"]
    meta = json.loads(str(deck["meta"]))
    todo = [w for w in dict.fromkeys(new_words) if w not in words]
    if not todo:
        log("all requested words already in deck")
        return

    jac = load_lens_jacobians(lens_path)
    d = jac[layers[0]].shape[0]
    cache_dir = os.path.dirname(os.path.abspath(deck_path))
    U = unembed_matrix(todo, hf_model, tokenizer_file, lm_head_file, cache_dir, d)

    apath = ainv_path_for(deck_path)
    ainv = None
    if os.path.exists(apath):
        ainv = np.load(apath, mmap_mode="r")
        if ainv.shape != (len(layers), d, d):
            log(f"solver cache {apath} has wrong shape; ignoring")
            ainv = None
    if ainv is None:
        log("no solver cache — solving from scratch (slower)")

    new_vecs, _ = solve_deck(jac, layers, U, meta.get("ridge", 0.05), ainv_stack=ainv)
    save_deck(deck_path, words + todo, layers,
              np.concatenate([vectors, new_vecs], axis=0), meta)
    log(f"added: {', '.join(todo)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lens", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--hf-model", default="Qwen/Qwen3.6-35B-A3B")
    ap.add_argument("--wordlist", default="tools/jlens_wordlist.txt")
    ap.add_argument("--ridge", type=float, default=0.05, help="relative ridge lambda")
    ap.add_argument("--add", default=None, help="comma-separated words to append to an existing deck")
    ap.add_argument("--lm-head-file", default=None)
    ap.add_argument("--tokenizer-file", default=None)
    ap.add_argument("--inspect", action="store_true")
    args = ap.parse_args()

    if args.inspect:
        load_lens_jacobians(args.lens, inspect=True)
        return

    if args.add:
        add_words_to_deck(
            args.out, args.lens, args.hf_model,
            [w.strip().lower() for w in args.add.split(",") if w.strip()],
            tokenizer_file=args.tokenizer_file, lm_head_file=args.lm_head_file,
        )
        return

    jac = load_lens_jacobians(args.lens)
    layers = sorted(jac)
    d = jac[layers[0]].shape[0]

    words = [
        w.strip()
        for w in open(args.wordlist, encoding="utf-8")
        if w.strip() and not w.strip().startswith("#")
    ]
    log(f"{len(words)} words from {args.wordlist}")

    cache_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(cache_dir, exist_ok=True)
    U = unembed_matrix(words, args.hf_model, args.tokenizer_file, args.lm_head_file, cache_dir, d)

    vectors, ainv = solve_deck(jac, layers, U, args.ridge, collect_ainv=True)
    save_deck(args.out, words, layers, vectors,
              {"model": args.hf_model, "d_model": d, "ridge": args.ridge})
    apath = ainv_path_for(args.out)
    atomic_save(apath, lambda p: np.save(open(p, "wb"), ainv))
    log(f"solver cache saved: {apath} ({ainv.nbytes / 1e6:.0f} MB) — incremental adds will be fast")


if __name__ == "__main__":
    main()

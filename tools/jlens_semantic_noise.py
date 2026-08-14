#!/usr/bin/env python3
"""Sparse semantic noise: a random *meaning-bearing* control vector.

Samples K random common-word tokens from the model's full vocabulary, blends
their unit unembedding rows with random positive weights, pulls the blend back
through the j-lens Jacobians, and writes a llama.cpp control-vector GGUF.
Unlike isotropic activation noise (which is ~orthogonal to every feature and
does nothing at safe norms), this tilts the whole session in a random but
semantic direction — a different "dream tilt" every time.

First run caches two artifacts next to the deck so later runs are fully local
and fast:
  lm-head.npy        the full unembedding matrix (fp16, ~620 MB, mmap-read)
  noise-tokens.json  candidate token ids (lowercase alphabetic words)

Usage:
  jlens_semantic_noise.py --deck data/jlens/deck.npz --lens lens.pt \
      [--hf-model Qwen/Qwen3.6-35B-A3B] [--tokens 8] [--strength 0.25] \
      [--layers 12-20] [--layer-offset 0] [--seed N] --out data/jlens/noise.gguf

Prints a machine-readable line for the caller:
  NOISE {"words": [...], "weights": [...], "strength": 0.25}
"""

import argparse
import json
import os
import re
import struct

import numpy as np
from gguf import GGUFWriter

from jlens_precompute import HF_BASE, ainv_path_for, http_get, load_lens_jacobians, log


def cache_dir_of(deck_path):
    return os.path.dirname(os.path.abspath(deck_path))


def load_candidates(cache_dir, repo):
    """Token ids of ' lowercaseword' pieces — the sampleable vocabulary."""
    cache = os.path.join(cache_dir, "noise-tokens.json")
    if os.path.exists(cache):
        return json.load(open(cache))
    tok_file = os.path.join(cache_dir, "tokenizer.json")
    raw = (
        open(tok_file, "rb").read()
        if os.path.exists(tok_file)
        else http_get(HF_BASE.format(repo=repo, file="tokenizer.json"))
    )
    vocab = json.loads(raw)["model"]["vocab"]
    # GPT2-style byte-level BPE: Ġ marks a leading space.
    cand = {piece[1:]: tid for piece, tid in vocab.items() if re.fullmatch(r"Ġ[a-z]{3,}", piece)}
    data = {"words": list(cand.keys()), "ids": list(cand.values())}
    json.dump(data, open(cache, "w"))
    log(f"candidate vocabulary: {len(cand)} words -> {cache}")
    return data


def lm_head_matrix(cache_dir, repo):
    """Full unembedding matrix as an mmap-read fp16 array (vocab, d)."""
    cache = os.path.join(cache_dir, "lm-head.npy")
    if not os.path.exists(cache):
        log("downloading full lm_head (one-time, ~620 MB) ...")
        try:
            index = json.loads(http_get(HF_BASE.format(repo=repo, file="model.safetensors.index.json")))
            name = "lm_head.weight" if "lm_head.weight" in index["weight_map"] else "model.embed_tokens.weight"
            shard = index["weight_map"][name]
        except Exception:
            name, shard = "lm_head.weight", "model.safetensors"
        url = HF_BASE.format(repo=repo, file=shard)
        header_len = struct.unpack("<Q", http_get(url, (0, 7)))[0]
        header = json.loads(http_get(url, (8, 8 + header_len - 1)))
        entry = header[name]
        dtype, (vocab, d) = entry["dtype"], entry["shape"]
        start = 8 + header_len + entry["data_offsets"][0]
        bytes_per = {"F16": 2, "BF16": 2, "F32": 4}[dtype]

        out = np.lib.format.open_memmap(
            cache + ".tmp", mode="w+", dtype=np.float16, shape=(vocab, d)
        )
        chunk_rows = 16384
        for r0 in range(0, vocab, chunk_rows):
            r1 = min(vocab, r0 + chunk_rows)
            a = start + r0 * d * bytes_per
            buf = http_get(url, (a, a + (r1 - r0) * d * bytes_per - 1))
            if dtype == "F16":
                rows = np.frombuffer(buf, dtype=np.float16).reshape(r1 - r0, d)
            elif dtype == "F32":
                rows = np.frombuffer(buf, dtype=np.float32).reshape(r1 - r0, d).astype(np.float16)
            else:  # BF16
                u32 = np.frombuffer(buf, dtype=np.uint16).astype(np.uint32) << 16
                rows = u32.view(np.float32).reshape(r1 - r0, d).astype(np.float16)
            out[r0:r1] = rows
            log(f"  {r1}/{vocab} rows")
        out.flush()
        del out
        os.replace(cache + ".tmp", cache)
        log(f"lm_head cached -> {cache}")
    return np.load(cache, mmap_mode="r")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deck", required=True)
    ap.add_argument("--lens", required=True)
    ap.add_argument("--hf-model", default="Qwen/Qwen3.6-35B-A3B")
    ap.add_argument("--tokens", type=int, default=8)
    ap.add_argument("--strength", type=float, default=0.25)
    ap.add_argument("--layers", default=None)
    ap.add_argument("--layer-offset", type=int, default=0)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    deck = np.load(args.deck, allow_pickle=False)
    layers = [int(l) for l in deck["layers"]]
    meta = json.loads(str(deck["meta"]))
    d = int(meta["d_model"])
    cache_dir = cache_dir_of(args.deck)

    cand = load_candidates(cache_dir, args.hf_model)
    lm_head = lm_head_matrix(cache_dir, args.hf_model)
    if lm_head.shape[1] != d:
        raise SystemExit(f"d_model mismatch: deck {d} vs lm_head {lm_head.shape[1]}")

    rng = np.random.default_rng(args.seed)
    picks = rng.choice(len(cand["ids"]), size=args.tokens, replace=False)
    words = [cand["words"][i] for i in picks]
    ids = [cand["ids"][i] for i in picks]
    weights = rng.uniform(0.0, 1.0, size=args.tokens)

    # Blend unit unembedding rows with positive weights -> one semantic direction.
    U = lm_head[np.array(ids)].astype(np.float32)
    U /= np.linalg.norm(U, axis=1, keepdims=True) + 1e-8
    u = weights @ U
    u /= np.linalg.norm(u) + 1e-8

    jac = load_lens_jacobians(args.lens)
    apath = ainv_path_for(args.deck)
    ainv = np.load(apath, mmap_mode="r") if os.path.exists(apath) else None

    lo, hi = 0, 10**9
    if args.layers:
        lo, hi = (int(x) for x in args.layers.split("-"))

    writer = GGUFWriter(args.out, arch="controlvector")
    writer.add_string("controlvector.model_hint", meta["model"])
    n_written = 0
    for li, layer in enumerate(layers):
        target = layer + args.layer_offset
        if target < 1 or not (lo <= layer <= hi):
            continue
        J = jac[layer]
        if ainv is not None:
            x = ainv[li] @ (J.T @ u)
        else:
            A = J.T @ J
            lam = meta.get("ridge", 0.05) * np.trace(A) / d
            A[np.diag_indices_from(A)] += lam
            x = np.linalg.solve(A, J.T @ u)
        x /= np.linalg.norm(x) + 1e-8
        writer.add_tensor(f"direction.{target}", (args.strength * x).astype(np.float32))
        n_written += 1
    writer.add_uint32("controlvector.layer_count", n_written)
    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    log(f"{args.out}: {n_written} layers, {args.tokens} tokens blended at ×{args.strength}")
    print(
        "NOISE "
        + json.dumps({"words": words, "weights": [round(float(w), 2) for w in weights], "strength": args.strength}),
        flush=True,
    )


if __name__ == "__main__":
    main()

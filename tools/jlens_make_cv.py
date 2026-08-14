#!/usr/bin/env python3
"""Combine deck vectors into a llama.cpp control-vector GGUF.

Reads the deck produced by jlens_precompute.py, sums the strength-weighted
unit pullback vectors of the chosen concepts per layer, and writes tensors
named "direction.<N>" — llama.cpp's control-vector format (N is 1-based;
the vector is added to the residual stream at the end of decoder layer N).

Usage:
  jlens_make_cv.py --deck data/jlens/deck.npz \
      --concepts "ocean:6,rust:4" --layers 8-30 --out data/jlens/current.gguf \
      [--layer-offset 0]

--layers filters on the lens layer indices stored in the deck. --layer-offset
shifts lens layer -> direction.<N> mapping if calibration shows an off-by-one
(default 0: lens layer k -> direction.k; layer 0 is always skipped since
llama.cpp indexes control vectors from 1).
"""

import argparse
import json

import numpy as np
from gguf import GGUFWriter


def parse_concepts(spec, default_strength):
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            word, strength = part.rsplit(":", 1)
            out.append((word.strip(), float(strength)))
        else:
            out.append((part, default_strength))
    if not out:
        raise SystemExit("no concepts given")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--deck", required=True)
    ap.add_argument("--concepts", required=True, help='e.g. "ocean:6,rust:4" or "ocean,rust"')
    ap.add_argument("--strength", type=float, default=5.0, help="default per-concept strength")
    ap.add_argument("--layers", default=None, help="lens layer range, e.g. 8-30 (default: all)")
    ap.add_argument("--layer-offset", type=int, default=0)
    ap.add_argument("--out", required=True)
    ap.add_argument("--auto-add", action="store_true",
                    help="solve missing concepts into the deck instead of erroring")
    ap.add_argument("--lens", default=None, help="lens .pt path (needed for --auto-add)")
    ap.add_argument("--hf-model", default="Qwen/Qwen3.6-35B-A3B")
    args = ap.parse_args()

    def load(path):
        deck = np.load(path, allow_pickle=False)
        return (
            [str(w) for w in deck["words"]],
            [int(l) for l in deck["layers"]],
            deck["vectors"],
            json.loads(str(deck["meta"])),
        )

    words, layers, vectors, meta = load(args.deck)
    d = vectors.shape[2]

    concepts = parse_concepts(args.concepts, args.strength)
    missing = [w for w, _ in concepts if w not in words]
    if missing and args.auto_add and args.lens:
        print(f"[jlens-make-cv] solving missing concepts into the deck: {missing}", flush=True)
        import jlens_precompute

        jlens_precompute.add_words_to_deck(args.deck, args.lens, args.hf_model, missing)
        words, layers, vectors, meta = load(args.deck)
        missing = [w for w, _ in concepts if w not in words]
    if missing:
        raise SystemExit(f"concepts not in deck: {missing} (re-run precompute with them in the wordlist)")

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
        v = np.zeros(d, dtype=np.float32)
        for word, strength in concepts:
            v += strength * vectors[words.index(word), li]
        writer.add_tensor(f"direction.{target}", v)
        n_written += 1
    writer.add_uint32("controlvector.layer_count", n_written)

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()

    desc = ", ".join(f"{w}:{s:g}" for w, s in concepts)
    print(f"[jlens-make-cv] {args.out}: {n_written} layers, d={d}, concepts: {desc}", flush=True)


if __name__ == "__main__":
    main()

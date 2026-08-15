import React from 'react';

// Concept chips (pinned/random j-lens injection or prompt seeds).
// Negative-strength concepts are steering *away* — not shown.
export function ConceptChips({ concepts, injected }) {
  if (!concepts?.length) return null;
  return concepts
    .filter((c) => c.strength == null || c.strength >= 0)
    .map((c) => (
      <span
        key={c.word}
        className={`concept-chip ${injected ? 'injected' : ''}`}
        title={
          (injected ? 'j-lens injected' : 'prompt seed') +
          (c.strength != null ? ` ×${c.strength}` : '')
        }
      >
        {c.word}
      </span>
    ));
}

// Semantic-noise words blended into the session's noise vector. Words with a
// negative weight (legacy signed rolls) are hidden.
export function NoiseChips({ noise }) {
  if (!noise?.words?.length) return null;
  return noise.words
    .map((word, i) => ({ word, weight: noise.weights?.[i] ?? null }))
    .filter(({ weight }) => weight == null || weight >= 0)
    .map(({ word, weight }) => (
      <span
        key={word}
        className="concept-chip noise"
        title={`noise ×${
          weight != null ? Math.round(weight * noise.strength * 100) / 100 : noise.strength
        }`}
      >
        {word}
      </span>
    ));
}

// Rival Battle system — gives every generated quiz a Pokémon "type", a
// rival trainer, and flavor text so answering questions feels like a
// real type-matchup battle instead of a plain quiz.
//
// Pure, dependency-free, deterministic: the same PDF title always rolls
// the same rival, so replaying a quiz doesn't reshuffle your opponent.

export const TYPES = [
  { id: "fire", label: "FIRE", icon: "🔥", color: "#e0562a", glow: "rgba(224, 86, 42, 0.55)" },
  { id: "water", label: "WATER", icon: "💧", color: "#3b8ee0", glow: "rgba(59, 142, 224, 0.55)" },
  { id: "grass", label: "GRASS", icon: "🌿", color: "#4fae5a", glow: "rgba(79, 174, 90, 0.55)" },
  { id: "electric", label: "ELECTRIC", icon: "⚡", color: "#e0b02a", glow: "rgba(224, 176, 42, 0.55)" },
  { id: "psychic", label: "PSYCHIC", icon: "🔮", color: "#c24fc2", glow: "rgba(194, 79, 194, 0.55)" },
  { id: "ice", label: "ICE", icon: "❄️", color: "#4fc4d6", glow: "rgba(79, 196, 214, 0.55)" },
  { id: "rock", label: "ROCK", icon: "🪨", color: "#a08858", glow: "rgba(160, 136, 88, 0.55)" },
  { id: "dragon", label: "DRAGON", icon: "🐉", color: "#7a5ae0", glow: "rgba(122, 90, 224, 0.55)" },
  { id: "ghost", label: "GHOST", icon: "👻", color: "#6a5a9e", glow: "rgba(106, 90, 158, 0.55)" },
  { id: "normal", label: "NORMAL", icon: "⭐", color: "#a8a888", glow: "rgba(168, 168, 136, 0.55)" },
];

const RIVAL_NAMES = {
  fire: ["Ember", "Blaze", "Cinder"],
  water: ["Marina", "Wade", "Coral"],
  grass: ["Sage", "Fern", "Briar"],
  electric: ["Volt", "Sparks", "Amper"],
  psychic: ["Nova", "Lucid", "Mystic"],
  ice: ["Frost", "Glacia", "Chilly"],
  rock: ["Boulder", "Flint", "Cobble"],
  dragon: ["Drake", "Wyrm", "Talon"],
  ghost: ["Wisp", "Shade", "Phantom"],
  normal: ["Riley", "Casey", "Robin"],
};

// Tiny deterministic string hash (djb2) — no crypto needed, just needs
// to spread similar titles across different types reasonably well.
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(h >>> 0);
}

/**
 * Roll a rival trainer + type for this quiz, seeded off the quiz title
 * (or filename) so the same source PDF always faces the same rival.
 */
export function pickRival(seed = "") {
  const h = hash(String(seed) || String(Date.now()));
  const type = TYPES[h % TYPES.length];
  const names = RIVAL_NAMES[type.id];
  const name = names[Math.floor(h / TYPES.length) % names.length];
  return { type, name };
}

export function battleIntroLine(rival) {
  return `Rival ${rival.name} wants to battle!`;
}

// Flavor line shown in the explanation box after a correct answer.
export function hitLine(rival, streak) {
  if (streak >= 5) return `CRITICAL HIT! ${rival.name} is reeling!`;
  if (streak >= 3) return `Super effective! ${rival.name} staggers back!`;
  return `Direct hit on ${rival.name}!`;
}

// Flavor line shown after a wrong answer.
export function missLine(rival) {
  const lines = [
    `${rival.name} dodges and counters!`,
    `${rival.name} shrugs it off!`,
    `Your attack missed — ${rival.name} strikes back!`,
  ];
  return lines[hash(rival.name + "miss") % lines.length];
}

export function victoryLine(rival) {
  return `${rival.name} is out of HP — victory!`;
}

export function defeatLine(rival) {
  return `${rival.name} held on — run it back for a rematch!`;
}

// Synthesized 8-bit / GBA-style sound effects using the Web Audio API.
// No external audio files needed — everything is generated on the fly,
// which keeps the app fast and avoids any licensing issues.

let ctx;
let muted = false;

export function setMuted(val) {
  muted = val;
}
export function isMuted() {
  return muted;
}

function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone({ freq = 440, duration = 0.1, type = "square", volume = 0.15, startTime = 0, slideTo = null }) {
  if (muted) return;
  const audioCtx = getCtx();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime + startTime);
  if (slideTo) {
    osc.frequency.linearRampToValueAtTime(slideTo, audioCtx.currentTime + startTime + duration);
  }

  gain.gain.setValueAtTime(volume, audioCtx.currentTime + startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + startTime + duration);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start(audioCtx.currentTime + startTime);
  osc.stop(audioCtx.currentTime + startTime + duration + 0.02);
}

export const sfx = {
  select() {
    tone({ freq: 880, duration: 0.05, type: "square", volume: 0.12 });
  },
  confirm() {
    tone({ freq: 660, duration: 0.06, type: "square", volume: 0.14 });
    tone({ freq: 990, duration: 0.08, type: "square", volume: 0.14, startTime: 0.06 });
  },
  correct() {
    tone({ freq: 523, duration: 0.09, type: "square", volume: 0.15 });
    tone({ freq: 659, duration: 0.09, type: "square", volume: 0.15, startTime: 0.09 });
    tone({ freq: 784, duration: 0.15, type: "square", volume: 0.15, startTime: 0.18 });
  },
  wrong() {
    tone({ freq: 200, duration: 0.25, type: "sawtooth", volume: 0.16, slideTo: 90 });
  },
  uiBlip() {
    tone({ freq: 1200, duration: 0.03, type: "square", volume: 0.08 });
  },
  levelUp() {
    [523, 659, 784, 1046].forEach((f, i) =>
      tone({ freq: f, duration: 0.12, type: "square", volume: 0.15, startTime: i * 0.1 })
    );
  },
  gameOver() {
    [400, 350, 300, 200].forEach((f, i) =>
      tone({ freq: f, duration: 0.2, type: "triangle", volume: 0.16, startTime: i * 0.18 })
    );
  },
  upload() {
    tone({ freq: 300, duration: 0.3, type: "square", volume: 0.1, slideTo: 900 });
  },
  tick() {
    tone({ freq: 700, duration: 0.04, type: "square", volume: 0.07 });
  },
  streak() {
    tone({ freq: 700, duration: 0.05, type: "square", volume: 0.13 });
    tone({ freq: 1050, duration: 0.08, type: "square", volume: 0.15, startTime: 0.05 });
  },
  badge() {
    [660, 880, 1100, 1320].forEach((f, i) =>
      tone({ freq: f, duration: 0.14, type: "square", volume: 0.16, startTime: i * 0.12 })
    );
  },
  powerup() {
    tone({ freq: 440, duration: 0.08, type: "square", volume: 0.14, slideTo: 1100 });
    tone({ freq: 1100, duration: 0.1, type: "square", volume: 0.12, startTime: 0.08 });
  },
  freeze() {
    tone({ freq: 1400, duration: 0.05, type: "sine", volume: 0.1 });
    tone({ freq: 1800, duration: 0.12, type: "sine", volume: 0.08, startTime: 0.05 });
  },
  skip() {
    tone({ freq: 500, duration: 0.06, type: "triangle", volume: 0.12, slideTo: 250 });
  },
  home() {
    tone({ freq: 600, duration: 0.05, type: "square", volume: 0.1 });
    tone({ freq: 400, duration: 0.08, type: "square", volume: 0.1, startTime: 0.05 });
  },
  theme() {
    tone({ freq: 300, duration: 0.06, type: "sine", volume: 0.1 });
    tone({ freq: 700, duration: 0.1, type: "sine", volume: 0.1, startTime: 0.06 });
  },
};
// Tiny dependency-free confetti burst, canvas-based.
// Pokemon-palette colors by default so it matches the rest of the app.

const COLORS = ["#d94040", "#f0c040", "#58a858", "#3b6ea5", "#f8f0d8", "#2c4a6e"];

export function burstConfetti({ duration = 1600, particleCount = 90, colors = COLORS } = {}) {
  if (typeof window === "undefined") return;

  const canvas = document.createElement("canvas");
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "9999";
  document.body.appendChild(canvas);

  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
  };
  resize();

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const w = window.innerWidth;
  const particles = Array.from({ length: particleCount }, () => ({
    x: w / 2 + (Math.random() - 0.5) * 120,
    y: window.innerHeight * 0.35,
    vx: (Math.random() - 0.5) * 9,
    vy: Math.random() * -9 - 3,
    size: Math.random() * 6 + 4,
    color: colors[Math.floor(Math.random() * colors.length)],
    rotation: Math.random() * 360,
    spin: (Math.random() - 0.5) * 18,
    gravity: 0.28 + Math.random() * 0.12,
    shape: Math.random() > 0.5 ? "rect" : "circle",
  }));

  const start = performance.now();

  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of particles) {
      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.fillStyle = p.color;
      if (p.shape === "rect") {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (elapsed < duration) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }

  requestAnimationFrame(frame);

  window.addEventListener("resize", resize, { once: true });
}
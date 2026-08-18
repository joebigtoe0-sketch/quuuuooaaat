/**
 * Full-screen 2D flourishes over the WebGL canvas: REKT / CALLED stamps,
 * confetti, ding/buzzer indicators. DOM-based so they read crisp on stream.
 */
export class Fx {
  constructor(private parent: HTMLElement) {}

  stamp(text: string, color: string): void {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText =
      `position:absolute;left:50%;top:42%;transform:translate(-50%,-50%) rotate(-14deg) scale(0.3);` +
      `color:${color};font:900 130px 'Arial Black',sans-serif;letter-spacing:6px;opacity:0;` +
      `border:8px solid ${color};padding:10px 30px;border-radius:12px;text-shadow:0 4px 20px #000;` +
      `box-shadow:0 0 40px ${color}55;z-index:20;pointer-events:none;transition:transform .18s cubic-bezier(.2,1.4,.4,1),opacity .18s;`;
    this.parent.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = "translate(-50%,-50%) rotate(-14deg) scale(1)";
      el.style.opacity = "1";
    });
    setTimeout(() => {
      el.style.transition = "opacity .5s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 550);
    }, 2000);
  }

  confetti(): void {
    const colors = ["#39ff88", "#2affd4", "#ffb454", "#ff4d6d", "#7fbfff"];
    for (let i = 0; i < 80; i++) {
      const p = document.createElement("div");
      const size = 6 + Math.random() * 8;
      p.style.cssText =
        `position:absolute;left:${40 + Math.random() * 20}%;top:35%;width:${size}px;height:${size}px;` +
        `background:${colors[i % colors.length]};z-index:19;pointer-events:none;border-radius:2px;`;
      this.parent.appendChild(p);
      const dx = (Math.random() - 0.5) * 900;
      const dy = 300 + Math.random() * 500;
      const rot = Math.random() * 720;
      p.animate(
        [
          { transform: "translate(0,0) rotate(0)", opacity: 1 },
          { transform: `translate(${dx}px,${dy}px) rotate(${rot}deg)`, opacity: 0 },
        ],
        { duration: 1400 + Math.random() * 800, easing: "cubic-bezier(.2,.6,.4,1)" },
      );
      setTimeout(() => p.remove(), 2400);
    }
  }

  flash(color: string): void {
    const el = document.createElement("div");
    el.style.cssText =
      `position:absolute;inset:0;background:${color};opacity:0.0;z-index:15;pointer-events:none;transition:opacity .12s;`;
    this.parent.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = "0.28"));
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 200);
    }, 130);
  }
}

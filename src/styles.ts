const STYLE_ID = 'r41-recording-player-styles';

export const STYLESHEET: string = `
.r41rp-root{position:relative;width:100%;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}
.r41rp-root *,.r41rp-root *::before,.r41rp-root *::after{box-sizing:inherit}
.r41rp-tabs{display:flex;gap:6px;margin-bottom:8px}
.r41rp-tab{border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:9999px;padding:4px 12px;font-size:13px;line-height:1.4;cursor:pointer}
.r41rp-tab:hover{background:#f3f4f6}
.r41rp-tab[aria-selected="true"]{background:#4f46e5;border-color:#4f46e5;color:#fff}
.r41rp-player{position:relative;width:100%;outline:none;border-radius:8px;overflow:hidden;background:#0f172a;color:#fff}
.r41rp-player:focus-visible{box-shadow:0 0 0 3px rgba(99,102,241,.5)}
.r41rp-stage{position:relative;width:100%;aspect-ratio:16/9;background:#0f172a;display:flex}
.r41rp-pane{height:100%;background:#000;min-width:0}
.r41rp-pane video{display:block;width:100%;height:100%;object-fit:contain;background:#000}
.r41rp-stage--split .r41rp-pane--screen{flex:7}
.r41rp-stage--split .r41rp-pane--camera{flex:3}
.r41rp-stage--camera .r41rp-pane--screen{display:none}
.r41rp-stage--camera .r41rp-pane--camera{width:100%}
.r41rp-stage--screen .r41rp-pane--camera{display:none}
.r41rp-stage--screen .r41rp-pane--screen{width:100%}
.r41rp-spinner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.r41rp-spinner svg{width:48px;height:48px;color:rgba(255,255,255,.9);animation:r41rp-spin 1s linear infinite;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))}
@keyframes r41rp-spin{to{transform:rotate(360deg)}}
.r41rp-controls{position:absolute;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);backdrop-filter:blur(4px);padding:6px 12px 8px}
.r41rp-scrubber{display:block;width:100%;height:10px;margin:0 0 4px;accent-color:#6366f1;cursor:pointer}
.r41rp-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.r41rp-toolbar-right{margin-left:auto;display:flex;align-items:center;gap:8px;position:relative}
.r41rp-btn{background:transparent;border:0;color:#fff;padding:6px;border-radius:9999px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:0}
.r41rp-btn:hover{background:rgba(255,255,255,.2)}
.r41rp-btn:disabled{opacity:.5;cursor:not-allowed}
.r41rp-btn svg{width:18px;height:18px}
.r41rp-play{width:32px;height:32px;padding:0;background:linear-gradient(90deg,#6366f1,#a855f7,#ec4899);box-shadow:0 4px 10px rgba(0,0,0,.3)}
.r41rp-play:hover{background:linear-gradient(90deg,#4f46e5,#9333ea,#db2777)}
.r41rp-time{font-size:13px;white-space:nowrap;margin-left:4px;font-variant-numeric:tabular-nums}
.r41rp-speed-btn{font-size:13px;padding:4px 10px;gap:4px;line-height:1}
.r41rp-speed-btn svg{width:14px;height:14px}
.r41rp-speed-menu{position:absolute;bottom:100%;right:0;margin-bottom:8px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 10px 15px rgba(0,0,0,.2);min-width:80px;overflow:hidden;z-index:50}
.r41rp-speed-option{display:block;width:100%;text-align:left;padding:8px 12px;font-size:13px;background:#fff;border:0;color:#374151;cursor:pointer}
.r41rp-speed-option:hover{background:#f3f4f6}
.r41rp-speed-option[aria-checked="true"]{background:#eef2ff;color:#4f46e5;font-weight:500}
.r41rp-empty{width:100%;aspect-ratio:16/9;background:#0f172a;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#9ca3af;text-align:center;padding:16px}
.r41rp-empty svg{width:48px;height:48px}
.r41rp-empty h3{margin:0;font-size:16px;font-weight:600;color:#d1d5db}
.r41rp-empty p{margin:0;font-size:13px}
.r41rp-retry{margin-top:8px;border:1px solid #6366f1;background:transparent;color:#c7d2fe;border-radius:9999px;padding:6px 14px;font-size:13px;cursor:pointer}
.r41rp-retry:hover{background:rgba(99,102,241,.2)}
.r41rp-player:fullscreen{border-radius:0;display:flex;flex-direction:column;background:#000}
.r41rp-player:fullscreen .r41rp-stage{flex:1;aspect-ratio:auto;min-height:0}
`;

export function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLESHEET;
  document.head.appendChild(style);
}

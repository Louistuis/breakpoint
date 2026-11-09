import { Game } from './Game';

const canvas = document.getElementById('game');
const root = document.getElementById('ui-root');

if (canvas instanceof HTMLCanvasElement && root instanceof HTMLElement) {
  Game.boot(canvas, root).catch((err: unknown) => {
    console.error('[breakpoint] failed to start', err);
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;inset:0;margin:0;padding:32px;background:#0b0c0e;color:#ff6a1a;font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:99';
    box.textContent = `BREAKPOINT could not start.\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
    document.body.append(box);
  });
}

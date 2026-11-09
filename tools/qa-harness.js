// Dev-only QA harness, loaded on demand from the browser console / automation.
(() => {
  const bp = window.__bp; const c = bp.ctx; const w = c.physics.world; const d = c.debris;
  const ring = []; let tickNo = 0; const log = (...a) => { ring.push([tickNo, ...a]); if (ring.length > 80) ring.shift(); };
  const bd = b => b ? [b.kind, b.sx, b.sy, b.sz, b.count] : null;
  const fell = [];
  const orb = d.removeBody.bind(d);
  d.removeBody = (b) => { let y = null; if (b.alive) { y = +b.rb.translation().y.toFixed(1); if (y < -5) fell.push([tickNo, ...bd(b), y]); log('removeBody', bd(b), y, b.rb.isSleeping() ? 'S' : 'A'); } return orb(b); };
  const ws = w.step.bind(w); const times = [];
  let nanSeen = false;
  const probeInfo = (b) => { const out = []; const n = b.rb.numColliders(); for (let i = 0; i < n; i++) { const co = b.rb.collider(i); if ((co.collisionGroups() >>> 16) === 0x0008) { const t = co.translation(); out.push([+t.x.toFixed(3), +t.y.toFixed(3), +t.z.toFixed(3), +co.shape.halfExtents.x.toFixed(2)]); } } return out; };
  window.__probeInfo = probeInfo;
  w.step = (...a) => { tickNo++; const t = performance.now(); try { const r = ws(...a); times.push(performance.now() - t);
      if (!nanSeen) for (const b of d.bodies) { if (!b.alive || b.rb.isSleeping()) continue; const p = b.rb.translation(), v = b.rb.linvel(), av = b.rb.angvel(); if (![p.x, p.y, p.z, v.x, v.y, v.z, av.x, av.y, av.z].every(Number.isFinite)) { nanSeen = true; log('NAN', bd(b), b.rb.numColliders(), [p.x, p.y, p.z, v.x, v.y, v.z, av.x].map(n => Number.isFinite(n) ? +n.toFixed(2) : String(n))); break; } }
      return r; } catch (e) { log('STEP THREW'); throw e; } };
  window.__scenario = (phases) => {
    let err = null, phase = null, k = 0; const sum = [];
    try {
      for (const ph of phases) {
        phase = ph.name; times.length = 0;
        for (const p of ph.blasts) c.explosions.explode(p[0], p[1], p[2], p[3]);
        const aw = [];
        for (k = 0; k < ph.ticks; k++) { bp.advance(1 / 60); if (k % 60 === 59) aw.push(d.bodies.filter(b => !b.rb.isSleeping()).length); }
        sum.push([ph.name, 'avg', +(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length)).toFixed(2), 'max', +Math.max(0, ...times).toFixed(1), 'awake/s', aw.join(',')]);
      }
    } catch (e) {
      err = String(e.stack || e).split('\n').slice(0, 7).map(s => s.replace(/http:\/\/localhost:5173\//, '').replace(/\?[tv]=\w+/, '').replace(/wasm:\/\/wasm\/\w+:wasm-function/, 'wf').trim()).join(' | ');
    }
    return { err, phase, k, tickNo, sum, fell, ring: err ? ring.slice(-12) : null, bodies: d.bodies.length, expl: c.explosions.count };
  };
  window.__COLS = [[60.1, 2.2, 20.1, 0.72], [70.1, 2.2, 20.1, 0.72], [60.1, 2.2, 27.1, 0.72], [70.1, 2.2, 27.1, 0.72]];
  window.__KIOSK = [[62, 2, 14, 1], [62, 2, 24, 1], [68, 2, 14, 1], [68, 2, 24, 1]];
  window.__ALL = [{ name: 'cols', blasts: __COLS, ticks: 720 }, { name: 'kiosk', blasts: __KIOSK, ticks: 600 }, { name: 'cols2', blasts: __COLS, ticks: 600 }, { name: 'kiosk2', blasts: __KIOSK, ticks: 600 }];
})();

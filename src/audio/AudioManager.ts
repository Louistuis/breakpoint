/**
 * BREAKPOINT audio. Everything is synthesised with the Web Audio API; there are no samples.
 *
 *   voice ─┬──────────────────────► dry ─┐
 *          └► send ► convolver ► wet ────┴► duck ─► limiter ─► master ─► destination
 *   ui voice ─────────────────────────────────────────┘
 *
 * A voice is one sounding event: a handful of layers (noise bursts, tones, tick trains)
 * summed into an input gain, optionally air-filtered and panned. Voices free themselves
 * from their sources' `ended` events.
 */
import { AIR_OPEN_HZ, SpatialAudio, isPoint } from './SpatialAudio';
import type { IAudio, LoopHandle, LoopKind, PlayOpts, SurfaceKind, UiSound, Vec3Like, WeaponSound } from './types';

// ───────────────────────────────────────────────────────────────────────── tuning

const MAX_VOICES = 28;
/** Estimated loudness (gain × distance attenuation) below which a request is not worth a voice. */
const MIN_AUDIBLE = 0.008;
const STEAL_FADE = 0.025;
/** A voice whose `ended` event never arrived is torn down this long after its scheduled end. */
const REAP_GRACE = 0.3;
const REAP_INTERVAL = 0.25;
/** Queued one-shots older than this predate a pause or a stall and are discarded, not replayed. */
const QUEUE_STALE = 0.25;

const NOISE_SECONDS = 2;
/** RMS of the shared noise buffers. With bandGain() a noise layer of gain g peaks near g, like a tone. */
const NOISE_RMS = 0.35;
const BROWN_CORNER_HZ = 150;
const REVERB_SECONDS = 1.6;
const REVERB_RETURN = 2;
const MASTER_TRIM = 0.85;
const AIR_BYPASS_HZ = 15000;
const MAX_TICKS = 220;
/** Extra source run time once an envelope has decayed to -60 dB. */
const TAIL = 0.03;
/** One-shots are accepted this long after unlock() while resume() is still settling. */
const RESUME_GRACE_MS = 600;
const RESUME_TIMEOUT_MS = 400;
const AMBIENCE_LEVEL = 0.85;
const AMBIENCE_FADE_IN = 2.5;
const AMBIENCE_FADE_OUT = 1.5;

const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

// ───────────────────────────────────────────────────────────────────────── maths

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
const logRand = (lo: number, hi: number): number => lo * Math.pow(hi / lo, Math.random());
const vary = (x: number, amount: number): number => x * (1 + (Math.random() * 2 - 1) * amount);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const finite = (x: number | undefined, fallback: number): number =>
  typeof x === 'number' && Number.isFinite(x) ? x : fallback;
/** Gap to the next event of a Poisson process with `rate` events per second. */
const poissonGap = (rate: number): number => -Math.log(1 - Math.random() * 0.999) / Math.max(rate, 0.01);

function smoothstep(lo: number, hi: number, x: number): number {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

const wallClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const optGain = (o: PlayOpts | undefined): number => clamp(finite(o?.gain, 1), 0, 4);
const optPitch = (o: PlayOpts | undefined): number => clamp(finite(o?.pitch, 1), 0.25, 4);
const optDelay = (o: PlayOpts | undefined): number => clamp(finite(o?.delay, 0), 0, 30);
const optPos = (o: PlayOpts | undefined): Vec3Like | null => (o && isPoint(o.pos) ? o.pos : null);

// ───────────────────────────────────────────────────────────────────────── shared buffers

type NoiseColor = 'white' | 'pink' | 'brown';
type BandType = 'lowpass' | 'highpass' | 'bandpass';

function fillNoise(out: Float32Array, color: NoiseColor, sampleRate: number): void {
  const n = out.length;
  if (color === 'white') {
    for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1;
    return;
  }
  if (color === 'pink') {
    // Paul Kellet's filter bank, -3 dB/octave within ±0.05 dB.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
    return;
  }
  // Brown: flat below the corner, -6 dB/octave above, with infrasonics removed so they cost no headroom.
  const a = Math.exp((-TAU * BROWN_CORNER_HZ) / sampleRate);
  const dcK = 1 - Math.exp((-TAU * 20) / sampleRate);
  let lp = 0;
  let dc = 0;
  for (let i = 0; i < n; i++) {
    lp = a * lp + (1 - a) * (Math.random() * 2 - 1);
    dc += dcK * (lp - dc);
    out[i] = lp - dc;
  }
}

function makeNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * NOISE_SECONDS);
  const overlap = Math.floor(sampleRate * 0.05);
  const raw = new Float32Array(length + overlap);
  fillNoise(raw, color, sampleRate);

  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    let s = raw[i];
    // Blend the overhang into the head so coloured noise loops without a step.
    if (i < overlap) {
      const w = i / overlap;
      s = s * Math.sqrt(w) + raw[length + i] * Math.sqrt(1 - w);
    }
    data[i] = s;
    sum += s * s;
  }
  const scale = NOISE_RMS / Math.sqrt(sum / length || 1);
  for (let i = 0; i < length; i++) data[i] *= scale;
  return buffer;
}

/** Short burst of dull noise: one discrete echo in the impulse response. */
function slap(data: Float32Array, at: number, amp: number, sampleRate: number): void {
  const n = Math.floor(sampleRate * 0.004);
  let lp = 0;
  for (let j = 0; j < n && at + j < data.length; j++) {
    const fall = 1 - j / n;
    lp += 0.45 * (Math.random() * 2 - 1 - lp);
    data[at + j] += lp * amp * fall * fall;
  }
}

/** Outdoor / industrial-yard impulse: sparse slaps off hard walls over a darkening diffuse tail. */
function makeImpulse(ctx: BaseAudioContext): AudioBuffer {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * REVERB_SECONDS);
  const impulse = ctx.createBuffer(2, length, sampleRate);
  const preDelay = Math.floor(sampleRate * 0.012);
  const fadeOut = Math.floor(sampleRate * 0.04);
  const lowK = 1 - Math.exp((-TAU * 180) / sampleRate);
  let energy = 0;

  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    let lp = 0;
    let low = 0;
    let a = 1;
    for (let i = preDelay; i < length; i++) {
      const t = (i - preDelay) / sampleRate;
      if (((i - preDelay) & 63) === 0) {
        const cutoff = 900 + 8000 * Math.exp(-3.2 * t);
        a = 1 - Math.exp((-TAU * cutoff) / sampleRate);
      }
      lp += a * (Math.random() * 2 - 1 - lp);
      low += lowK * (lp - low);
      // -60 dB at the end of the buffer; the dense part builds in so the early slaps stay distinct.
      data[i] = (lp - low) * Math.exp(-4.4 * t) * Math.min(1, t / 0.03);
    }
    for (let k = 0; k < 6; k++) slap(data, preDelay + Math.floor(sampleRate * rand(0.004, 0.09)), rand(2, 4), sampleRate);
    for (let k = 0; k < 3; k++) slap(data, preDelay + Math.floor(sampleRate * rand(0.11, 0.34)), rand(1.2, 2.4), sampleRate);
    for (let i = 0; i < fadeOut; i++) data[length - 1 - i] *= i / fadeOut;
    for (let i = 0; i < length; i++) energy += data[i] * data[i];
  }

  // Unit energy per channel (normalize is off), so the return level does not depend on the browser.
  const scale = 1 / Math.sqrt(energy / 2 || 1);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] *= scale;
  }
  return impulse;
}

/**
 * Make-up gain for filtered noise. A narrow band keeps only a sliver of the buffer's energy
 * (white through a 400 Hz low-pass loses ~18 dB), so layer gains would otherwise mean
 * something different for every colour/filter pair. Estimates the kept energy fraction
 * from the noise spectrum and returns 1/sqrt of it.
 */
function bandGain(color: NoiseColor, type: BandType, freq: number, q: number, nyquist: number): number {
  let kept: number;
  if (color === 'white') {
    kept = type === 'lowpass' ? freq / nyquist : type === 'highpass' ? 1 - freq / nyquist : (HALF_PI * freq) / (q * nyquist);
  } else if (color === 'pink') {
    const span = Math.log(nyquist / 20);
    kept =
      type === 'lowpass'
        ? Math.log(Math.max(freq, 25) / 20) / span
        : type === 'highpass'
          ? Math.log(nyquist / Math.min(freq, nyquist * 0.9)) / span
          : HALF_PI / (q * span);
  } else {
    const x = freq / BROWN_CORNER_HZ;
    const below = Math.atan(x) / HALF_PI;
    kept = type === 'lowpass' ? below : type === 'highpass' ? 1 - below : x / (q * (1 + x * x));
  }
  return 1 / Math.sqrt(clamp(kept, 0.015, 1));
}

// ───────────────────────────────────────────────────────────────────────── automation

/** Linear attack, optional hold, exponential decay to -60 dB over `decay` seconds. */
function envelope(p: AudioParam, t: number, peak: number, attack: number, hold: number, decay: number): void {
  const level = Math.max(peak, 1e-4);
  const top = t + Math.max(attack, 0.0003);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(level, top);
  if (hold > 0) p.setValueAtTime(level, top + hold);
  p.exponentialRampToValueAtTime(level * 0.001, top + hold + Math.max(decay, 0.003));
}

function glide(p: AudioParam, t: number, from: number, to: number, seconds: number): void {
  p.setValueAtTime(from, t);
  p.exponentialRampToValueAtTime(Math.max(to, 1), t + Math.max(seconds, 0.002));
}

type Shape = (u: number) => number;

/**
 * Irregular drift: ramps between random levels in [lo, hi] every stepLo..stepHi seconds,
 * scaled by `shape` over the normalised duration. Stands in for an LFO where a periodic
 * wobble would sound mechanical (rumbles, groans, rolling tails).
 */
function wobble(
  p: AudioParam,
  t0: number,
  dur: number,
  lo: number,
  hi: number,
  stepLo: number,
  stepHi: number,
  shape: Shape | null,
): void {
  const end = t0 + dur;
  p.setValueAtTime((shape ? shape(0) : 1) * (lo + hi) * 0.5, t0);
  let t = t0;
  while (t < end) {
    t = Math.min(end, t + rand(stepLo, stepHi));
    p.linearRampToValueAtTime(rand(lo, hi) * (shape ? shape((t - t0) / dur) : 1), t);
  }
}

// Envelope shapes over normalised time; all but `fadeShape` start and end at zero.
const fadeShape: Shape = (u) => (1 - u) * (1 - u);
const swellShape: Shape = (u) => Math.min(1, u / 0.12) * Math.pow(Math.max(0, 1 - u), 1.3);
const rollShape: Shape = (u) => Math.min(1, u / 0.06) * Math.pow(Math.max(0, 1 - u), 1.6);
const groanShape: Shape = (u) => Math.max(0, Math.min(1, u / 0.1, (1 - u) / 0.2));
const passShape: Shape = (u) => Math.pow(Math.max(0, Math.sin(Math.PI * u)), 1.5);

// ───────────────────────────────────────────────────────────────────────── voice

/** Decaying burst of filtered noise. Times are seconds relative to the voice start. */
interface NoiseLayer {
  color: NoiseColor;
  filter: BandType;
  freq: number;
  /** Cutoff/centre glides here (exponentially) within `sweep` seconds. */
  freqEnd?: number;
  sweep?: number;
  q?: number;
  at?: number;
  attack?: number;
  hold?: number;
  /** Decay time to -60 dB. */
  dur: number;
  gain: number;
  into?: AudioNode;
}

/** Decaying oscillator, optionally swept. */
interface ToneLayer {
  wave?: OscillatorType;
  freq: number;
  freqEnd?: number;
  sweep?: number;
  at?: number;
  attack?: number;
  hold?: number;
  dur: number;
  gain: number;
  into?: AudioNode;
}

/** Random stream of tiny noise ticks (crackle, crunch, splinters) from one source. */
interface TickLayer {
  color: NoiseColor;
  filter: BandType;
  freq: number;
  q?: number;
  /** Per-tick random detune of the filter, as a fraction of `freq`. */
  spread?: number;
  at?: number;
  dur: number;
  gain: number;
  /** Ticks per second where `shape` is 1. */
  rate: number;
  /** Decay time-constant of one tick. */
  tau: number;
  /** Density and level over normalised time; defaults to a fade. */
  shape?: Shape;
  into?: AudioNode;
}

/** Cascade of short high pings, front-loaded in time. */
interface PingLayer {
  at?: number;
  dur: number;
  count: number;
  /** Oscillators sharing the pings; each plays its share one after another. */
  streams: number;
  low: number;
  high: number;
  gain: number;
}

/** Inharmonic decaying sine partials: struck metal. */
interface PartialLayer {
  at?: number;
  base: number;
  count: number;
  /** Decay of the fundamental; higher partials die faster. */
  ring: number;
  gain: number;
  bright?: number;
  shimmer?: boolean;
}

/** Sustained filtered noise with an irregular level (and optionally cutoff) drift. */
interface RumbleLayer {
  color: NoiseColor;
  filter?: BandType;
  freq: number;
  /** When set the cutoff wanders between `freqLo` and `freq`. */
  freqLo?: number;
  q?: number;
  at?: number;
  dur: number;
  gain: number;
  /** 0..1 depth of the level wobble. */
  depth?: number;
  shape: Shape;
  into?: AudioNode;
}

/** Sustained oscillator with an irregular level wobble. */
interface DroneLayer {
  wave?: OscillatorType;
  freq: number;
  at?: number;
  dur: number;
  gain: number;
  depth?: number;
  shape: Shape;
  into?: AudioNode;
}

/** Endless filtered noise for loops and ambience. */
interface BedLayer {
  color: NoiseColor;
  filter: BandType;
  freq: number;
  q?: number;
  gain: number;
  into?: AudioNode;
}

interface Bed {
  source: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  /** bandGain() of this bed, for callers that automate `gain` themselves. */
  unit: number;
}

interface VoiceHost {
  readonly ctx: AudioContext;
  readonly nyquist: number;
  readonly noise: Readonly<Record<NoiseColor, AudioBuffer>>;
  release(voice: Voice): void;
}

type VoiceState = 'live' | 'stolen' | 'dead';

const METAL_RATIOS: readonly number[] = [1, 1.58, 2.24, 2.92, 3.87, 5.12];

class Voice {
  /** Sum of all layers; its gain is the voice level. */
  readonly input: GainNode;
  /** Last node before the buses: the input, the air filter or the panner. */
  tail: AudioNode;
  panner: PannerNode | null = null;
  send: GainNode | null = null;
  state: VoiceState = 'live';
  stealable = true;
  /** Latest scheduled stop of any source; Infinity while a loop runs. */
  endTime: number;

  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private pending = 0;
  private readonly onSourceEnded = (): void => {
    if (--this.pending <= 0) this.host.release(this);
  };

  constructor(
    private readonly host: VoiceHost,
    readonly t0: number,
    /** Multiplier applied to every layer frequency: the caller's pitch times a random spread. */
    readonly pitch: number,
    readonly loudness: number,
    readonly distance: number,
    readonly rolloff: number,
  ) {
    this.input = this.gain(1);
    this.tail = this.input;
    this.endTime = t0;
  }

  // ── primitives (frequencies taken as given) ──

  /** Registers a node so it is disconnected when the voice ends. */
  own<T extends AudioNode>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  gain(value: number): GainNode {
    const g = this.own(this.host.ctx.createGain());
    g.gain.value = value;
    return g;
  }

  filter(type: BandType, freq: number, q = 0.707): BiquadFilterNode {
    const f = this.own(this.host.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = this.hz(freq);
    // Swept and wobbled cutoffs only need a new coefficient set per render quantum, not per sample.
    f.frequency.automationRate = 'k-rate';
    f.Q.value = q;
    return f;
  }

  osc(wave: OscillatorType, freq: number, start: number, stop: number): OscillatorNode {
    const o = this.host.ctx.createOscillator();
    o.type = wave;
    o.frequency.value = this.hz(freq);
    o.start(start);
    return this.arm(o, stop);
  }

  noiseSource(color: NoiseColor, start: number, stop: number): AudioBufferSourceNode {
    const src = this.host.ctx.createBufferSource();
    src.buffer = this.host.noise[color];
    src.loop = true;
    src.playbackRate.value = clamp(this.pitch, 0.25, 4);
    src.start(start, Math.random() * (NOISE_SECONDS - 0.05));
    return this.arm(src, stop);
  }

  /** Slow oscillator added onto `target`. */
  lfo(freq: number, depth: number, target: AudioParam): OscillatorNode {
    const o = this.host.ctx.createOscillator();
    o.frequency.value = freq;
    o.start(this.t0);
    this.arm(o, Infinity);
    const g = this.gain(depth);
    o.connect(g);
    g.connect(target);
    return o;
  }

  /** Stereo position for 2D beds; centre where StereoPannerNode is unavailable. */
  placed(pan: number): AudioNode {
    const ctx = this.host.ctx;
    if (typeof ctx.createStereoPanner !== 'function') return this.input;
    const p = this.own(ctx.createStereoPanner());
    p.pan.value = pan;
    p.connect(this.input);
    return p;
  }

  // ── layers (frequencies scaled by the voice pitch) ──

  noise(s: NoiseLayer): void {
    const t = this.t0 + (s.at ?? 0);
    const attack = s.attack ?? 0.001;
    const hold = s.hold ?? 0;
    const q = s.q ?? 0.707;
    const from = this.hz(s.freq * this.pitch);
    const src = this.noiseSource(s.color, t, t + attack + hold + s.dur + TAIL);
    const f = this.filter(s.filter, from, q);
    if (s.freqEnd !== undefined) {
      glide(f.frequency, t, from, this.hz(s.freqEnd * this.pitch), s.sweep ?? attack + hold + s.dur * 0.6);
    }
    const g = this.gain(0);
    envelope(g.gain, t, s.gain * bandGain(s.color, s.filter, s.freq, q, this.host.nyquist), attack, hold, s.dur);
    src.connect(f);
    f.connect(g);
    g.connect(s.into ?? this.input);
  }

  tone(s: ToneLayer): void {
    if (s.gain <= 0) return;
    const t = this.t0 + (s.at ?? 0);
    const attack = s.attack ?? 0.001;
    const hold = s.hold ?? 0;
    const length = attack + hold + s.dur;
    const from = this.hz(s.freq * this.pitch);
    const o = this.osc(s.wave ?? 'sine', from, t, t + length + TAIL);
    if (s.freqEnd !== undefined) glide(o.frequency, t, from, this.hz(s.freqEnd * this.pitch), s.sweep ?? length);
    const g = this.gain(0);
    envelope(g.gain, t, s.gain, attack, hold, s.dur);
    o.connect(g);
    g.connect(s.into ?? this.input);
  }

  /**
   * Mechanical click: a tight band of noise plus a short pitched tick. A burst this short holds
   * only a few independent noise samples and varies from hit to hit; the tick keeps it consistent.
   */
  click(at: number, freq: number, gain: number, dur = 0.012): void {
    this.noise({ color: 'white', filter: 'bandpass', freq, q: 2.2, at, attack: 0.0005, dur, gain });
    this.tone({ wave: 'triangle', freq: freq * 0.58, at, attack: 0.0005, dur: dur * 0.8, gain: gain * 0.5 });
  }

  ticks(s: TickLayer): void {
    const start = this.t0 + (s.at ?? 0);
    const end = start + s.dur;
    const q = s.q ?? 0.707;
    const centre = this.hz(s.freq * this.pitch);
    const shape = s.shape ?? fadeShape;
    const peak = s.gain * bandGain(s.color, s.filter, s.freq, q, this.host.nyquist);

    const src = this.noiseSource(s.color, start, end + 0.06);
    const f = this.filter(s.filter, centre, q);
    const g = this.gain(0);
    src.connect(f);
    f.connect(g);
    g.connect(s.into ?? this.input);

    // One gain node gated by automation instead of a source per tick: a 4 s collapse would
    // otherwise need a hundred short-lived nodes.
    let t = start;
    let n = 0;
    while (t < end && n < MAX_TICKS) {
      const e = shape((t - start) / s.dur);
      if (e > 0.02) {
        g.gain.setValueAtTime(peak * e * rand(0.35, 1), t);
        g.gain.setTargetAtTime(0, t, s.tau * rand(0.6, 1.6));
        if (s.spread) f.frequency.setValueAtTime(this.hz(centre * (1 + rand(-s.spread, s.spread))), t);
        n++;
      }
      t += Math.max(0.0005, poissonGap(s.rate * Math.max(e, 0.12)));
    }
    g.gain.setTargetAtTime(0, end, 0.012);
  }

  pings(s: PingLayer): void {
    const start = this.t0 + (s.at ?? 0);
    const streams = clamp(Math.round(s.streams), 1, 8);
    const perStream = Math.max(1, Math.round(s.count / streams));
    for (let j = 0; j < streams; j++) {
      const o = this.osc(j % 2 ? 'triangle' : 'sine', s.low, start, start + s.dur + 0.25);
      const g = this.gain(0);
      o.connect(g);
      g.connect(this.input);
      for (let i = 0; i < perStream; i++) {
        // Jittered and skewed towards the start; still strictly increasing within a stream.
        const u = Math.pow((i + Math.random()) / perStream, 1.7);
        const t = start + u * s.dur;
        o.frequency.setValueAtTime(this.hz(logRand(s.low, s.high) * this.pitch), t);
        g.gain.setValueAtTime(s.gain * rand(0.35, 1) * (1 - 0.6 * u), t);
        g.gain.setTargetAtTime(0, t, rand(0.008, 0.04));
      }
    }
  }

  partials(s: PartialLayer): void {
    const count = Math.min(s.count, METAL_RATIOS.length);
    for (let i = 0; i < count; i++) {
      const freq = s.base * vary(METAL_RATIOS[i], 0.03);
      const gain = s.gain * Math.pow(0.78, i) * (i === 0 ? 1 : (s.bright ?? 1));
      const dur = s.ring / (1 + 0.55 * i);
      this.tone({ freq, at: s.at, attack: 0.0006, dur, gain });
      // A slightly detuned twin makes the fundamental beat like a real plate.
      if (i === 0 && s.shimmer) {
        this.tone({ freq: freq * rand(1.004, 1.011), at: s.at, attack: 0.0006, dur: dur * 0.9, gain: gain * 0.5 });
      }
    }
  }

  rumble(s: RumbleLayer): void {
    const start = this.t0 + (s.at ?? 0);
    const type = s.filter ?? 'lowpass';
    const q = s.q ?? 0.707;
    const hi = this.hz(s.freq * this.pitch);
    const src = this.noiseSource(s.color, start, start + s.dur + 0.05);
    const f = this.filter(type, hi, q);
    const g = this.gain(0);
    src.connect(f);
    f.connect(g);
    g.connect(s.into ?? this.input);

    let reference = s.freq;
    if (s.freqLo !== undefined) {
      wobble(f.frequency, start, s.dur, this.hz(s.freqLo * this.pitch), hi, 0.2, 0.5, null);
      reference = Math.sqrt(s.freq * s.freqLo);
    }
    const peak = s.gain * bandGain(s.color, type, reference, q, this.host.nyquist);
    wobble(g.gain, start, s.dur, peak * (1 - (s.depth ?? 0.4)), peak, 0.07, 0.2, s.shape);
  }

  drone(s: DroneLayer): OscillatorNode {
    const start = this.t0 + (s.at ?? 0);
    const o = this.osc(s.wave ?? 'sine', s.freq * this.pitch, start, start + s.dur + 0.05);
    const g = this.gain(0);
    o.connect(g);
    g.connect(s.into ?? this.input);
    wobble(g.gain, start, s.dur, s.gain * (1 - (s.depth ?? 0.5)), s.gain, 0.1, 0.3, s.shape);
    return o;
  }

  bed(s: BedLayer): Bed {
    const q = s.q ?? 0.707;
    const source = this.noiseSource(s.color, this.t0, Infinity);
    const filter = this.filter(s.filter, s.freq * this.pitch, q);
    const unit = bandGain(s.color, s.filter, s.freq, q, this.host.nyquist);
    const gain = this.gain(s.gain * unit);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(s.into ?? this.input);
    return { source, filter, gain, unit };
  }

  // ── lifecycle ──

  /**
   * Moves the voice level towards `to`, settling within `seconds`. Safe to call mid-fade.
   * Never scheduled before the voice starts: an earlier event would sort ahead of the
   * start-of-voice fade and be overridden by it.
   */
  fade(to: number, now: number, seconds: number): void {
    this.input.gain.setTargetAtTime(to, Math.max(now, this.t0), Math.max(seconds, 0.004) / 4);
  }

  /** Ends the voice early; teardown still happens from the sources' `ended` events. */
  cut(now: number, fadeSeconds: number): void {
    let stop = now;
    if (now < this.t0) {
      // Not sounding yet (still inside its start delay): silence it outright.
      this.input.gain.cancelScheduledValues(0);
      this.input.gain.value = 0;
    } else {
      this.fade(0, now, fadeSeconds);
      stop = now + fadeSeconds + 0.01;
    }
    for (const s of this.sources) s.stop(stop);
    this.endTime = stop;
  }

  /** Loudness estimate used to pick a steal victim: voices count for less as they play out. */
  loudnessAt(now: number): number {
    if (now <= this.t0 || this.endTime === Infinity) return this.loudness;
    const span = this.endTime - this.t0;
    if (span <= 0) return 0;
    return this.loudness * clamp((this.endTime - now) / span, 0.02, 1);
  }

  dispose(): void {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    for (const n of this.nodes) n.disconnect();
    this.sources.length = 0;
    this.nodes.length = 0;
  }

  private arm<T extends AudioScheduledSourceNode>(src: T, stop: number): T {
    this.nodes.push(src);
    this.sources.push(src);
    this.pending++;
    src.onended = this.onSourceEnded;
    if (stop !== Infinity) src.stop(stop);
    if (stop > this.endTime) this.endTime = stop;
    return src;
  }

  private hz(freq: number): number {
    return clamp(freq, 8, this.host.nyquist * 0.94);
  }
}

// ───────────────────────────────────────────────────────────────────────── rate limiting

/** At most `max` events per sliding `window` seconds. */
class RateLimiter {
  private readonly stamps: Float64Array;
  private head = 0;

  constructor(max: number, private readonly window: number) {
    this.stamps = new Float64Array(max).fill(-Infinity);
  }

  ready(now: number): boolean {
    return now - this.stamps[this.head] >= this.window;
  }

  mark(now: number): void {
    this.stamps[this.head] = now;
    this.head = (this.head + 1) % this.stamps.length;
  }
}

/** A one-shot request parked until the end-of-frame flush. Positions are copied, callers reuse vectors. */
interface Pending {
  score: number;
  surface: SurfaceKind;
  amount: number;
  spatial: boolean;
  x: number;
  y: number;
  z: number;
  gain: number;
  pitch: number;
  delay: number;
}

/**
 * Keeps the loudest few requests of a category made since the last flush. A frame that
 * asks for 200 debris impacts therefore costs 200 comparisons and plays only the handful
 * that would have been heard, loudest first, as far as the rate limit allows.
 */
class BurstQueue {
  count = 0;
  /** Context time of the oldest queued request. */
  stamp = 0;
  private readonly slots: Pending[] = [];

  constructor(
    capacity: number,
    private readonly burst: RateLimiter,
    private readonly sustained: RateLimiter | null = null,
  ) {
    for (let i = 0; i < capacity; i++) {
      this.slots.push({ score: 0, surface: 'concrete', amount: 0, spatial: false, x: 0, y: 0, z: 0, gain: 1, pitch: 1, delay: 0 });
    }
  }

  /** A slot for a request of loudness `score`, or null when everything queued is louder. */
  claim(score: number, now: number): Pending | null {
    if (this.count === 0) this.stamp = now;
    if (this.count < this.slots.length) return this.slots[this.count++];
    let weakest = this.slots[0];
    for (let i = 1; i < this.count; i++) {
      if (this.slots[i].score < weakest.score) weakest = this.slots[i];
    }
    return score > weakest.score ? weakest : null;
  }

  takeLoudest(): Pending | null {
    if (this.count === 0) return null;
    let best = 0;
    for (let i = 1; i < this.count; i++) {
      if (this.slots[i].score > this.slots[best].score) best = i;
    }
    const last = --this.count;
    const taken = this.slots[best];
    this.slots[best] = this.slots[last];
    this.slots[last] = taken;
    return taken;
  }

  clear(): void {
    this.count = 0;
  }

  ready(now: number): boolean {
    return this.burst.ready(now) && (this.sustained === null || this.sustained.ready(now));
  }

  mark(now: number): void {
    this.burst.mark(now);
    this.sustained?.mark(now);
  }
}

// ───────────────────────────────────────────────────────────────────────── recipes: weapons

interface WeaponDef {
  level: number;
  send: number;
  /** Inverse-model rolloff; below 1 the sound carries further than physics would allow. */
  rolloff: number;
  build: (v: Voice) => void;
}

function buildPistol(v: Voice): void {
  v.noise({ color: 'white', filter: 'highpass', freq: vary(1900, 0.15), attack: 0.0005, dur: 0.06, gain: 1.5 });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(850, 0.2), q: 0.8, dur: 0.1, gain: 0.8 });
  v.tone({ freq: vary(180, 0.08), freqEnd: 60, sweep: 0.09, dur: 0.11, gain: 0.85 });
  v.click(rand(0.05, 0.065), vary(3200, 0.15), 0.22);
  v.click(rand(0.09, 0.11), vary(2100, 0.15), 0.1);
}

function buildShotgun(v: Voice): void {
  v.noise({ color: 'white', filter: 'highpass', freq: vary(800, 0.15), attack: 0.0005, dur: 0.1, gain: 1.5 });
  v.noise({ color: 'pink', filter: 'lowpass', freq: vary(2600, 0.15), freqEnd: 280, dur: 0.36, gain: 1.1 });
  v.noise({ color: 'brown', filter: 'lowpass', freq: 220, dur: 0.4, gain: 0.9 });
  v.tone({ freq: vary(140, 0.08), freqEnd: 40, sweep: 0.16, dur: 0.34, gain: 1.2 });
  v.tone({ wave: 'triangle', freq: vary(260, 0.1), freqEnd: 90, sweep: 0.07, dur: 0.12, gain: 0.5 });
}

/** One stroke of a pump action: bolt noise, two metallic partials and the knock of the fore-end. */
function clack(v: Voice, at: number, bright: number, gain: number): void {
  v.noise({ color: 'white', filter: 'bandpass', freq: 1500 * bright, q: 1.8, at, dur: 0.035, gain: 0.9 * gain });
  v.tone({ wave: 'triangle', freq: 820 * bright, at, dur: 0.03, gain: 0.3 * gain });
  v.tone({ wave: 'triangle', freq: 1370 * bright, at, dur: 0.022, gain: 0.2 * gain });
  v.tone({ freq: 230 * bright, freqEnd: 140, at, dur: 0.045, gain: 0.5 * gain });
}

function buildShotgunPump(v: Voice): void {
  const gap = rand(0.14, 0.19);
  clack(v, 0, vary(0.9, 0.05), 0.85);
  v.noise({ color: 'pink', filter: 'bandpass', freq: 2400, q: 1.2, at: 0.02, attack: 0.05, dur: gap * 0.6, gain: 0.15 });
  clack(v, gap, vary(1.12, 0.05), 1);
}

function buildRocketLaunch(v: Voice): void {
  v.noise({ color: 'white', filter: 'highpass', freq: 2500, dur: 0.035, gain: 0.5 });
  v.noise({
    color: 'pink',
    filter: 'bandpass',
    freq: vary(320, 0.15),
    freqEnd: vary(2600, 0.15),
    sweep: 0.45,
    q: 1.1,
    attack: 0.05,
    hold: 0.1,
    dur: 0.5,
    gain: 1,
  });
  v.noise({ color: 'brown', filter: 'lowpass', freq: 240, dur: 0.3, gain: 1 });
  v.tone({ freq: vary(115, 0.08), freqEnd: 40, sweep: 0.18, dur: 0.26, gain: 1 });
}

function buildHammerSwing(v: Voice): void {
  v.noise({
    color: 'pink',
    filter: 'bandpass',
    freq: vary(480, 0.15),
    freqEnd: vary(1500, 0.15),
    sweep: 0.11,
    q: 0.9,
    attack: 0.07,
    dur: 0.14,
    gain: 0.7,
  });
  v.noise({ color: 'white', filter: 'highpass', freq: 3000, attack: 0.08, dur: 0.1, gain: 0.15 });
}

function buildHammerHit(v: Voice): void {
  v.tone({ freq: vary(98, 0.08), freqEnd: 44, sweep: 0.08, dur: 0.2, gain: 1.1 });
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(330, 0.15), dur: 0.13, gain: 1 });
  v.tone({ wave: 'triangle', freq: vary(310, 0.12), freqEnd: 230, dur: 0.055, gain: 0.45 });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(900, 0.2), q: 1.4, dur: 0.035, gain: 0.6 });
  v.noise({ color: 'white', filter: 'highpass', freq: 3000, dur: 0.008, gain: 0.3 });
}

/** Electronic beep with a flat top; the octave partial keeps it audible on small speakers. */
function beep(v: Voice, at: number, freq: number, length: number, gain: number): void {
  v.tone({ freq, at, attack: 0.002, hold: length, dur: 0.02, gain });
  v.tone({ wave: 'triangle', freq: freq * 2, at, attack: 0.002, hold: length, dur: 0.015, gain: gain * 0.18 });
}

function buildChargePlace(v: Voice): void {
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(480, 0.15), dur: 0.08, gain: 0.8 });
  v.tone({ freq: vary(150, 0.1), freqEnd: 88, dur: 0.075, gain: 0.55 });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(1800, 0.2), q: 0.8, at: 0.012, attack: 0.018, dur: 0.05, gain: 0.2 });
  beep(v, rand(0.1, 0.13), 2100, 0.04, 0.2);
}

function buildChargeBeep(v: Voice): void {
  beep(v, 0, 2050, 0.06, 0.6);
}

function buildDetonator(v: Voice): void {
  v.click(0, vary(3400, 0.1), 0.6, 0.01);
  v.tone({ wave: 'triangle', freq: vary(1900, 0.1), dur: 0.008, gain: 0.2 });
  const at = rand(0.06, 0.085);
  v.noise({ color: 'white', filter: 'bandpass', freq: vary(1400, 0.12), q: 1.8, at, dur: 0.032, gain: 0.8 });
  v.tone({ freq: vary(240, 0.1), freqEnd: 150, at, dur: 0.04, gain: 0.5 });
  v.tone({ wave: 'triangle', freq: vary(950, 0.1), at, dur: 0.02, gain: 0.2 });
}

function buildReload(v: Voice): void {
  // Release catch, magazine sliding out, new magazine seating, slide going home.
  v.click(0, vary(2800, 0.1), 0.5);
  v.noise({
    color: 'pink',
    filter: 'bandpass',
    freq: vary(1300, 0.1),
    freqEnd: 700,
    q: 1.3,
    at: 0.04,
    attack: 0.03,
    dur: 0.09,
    gain: 0.25,
  });
  const seat = rand(0.27, 0.32);
  v.noise({ color: 'white', filter: 'bandpass', freq: vary(1100, 0.12), q: 1.6, at: seat, dur: 0.03, gain: 0.7 });
  v.tone({ freq: vary(200, 0.1), freqEnd: 120, at: seat, dur: 0.045, gain: 0.6 });
  const rack = seat + rand(0.15, 0.18);
  v.click(rack, vary(3200, 0.1), 0.6, 0.014);
  v.tone({ wave: 'triangle', freq: vary(1500, 0.1), at: rack, dur: 0.028, gain: 0.2 });
  v.click(rack + 0.035, vary(2400, 0.1), 0.35);
}

function buildEmpty(v: Voice): void {
  v.click(0, vary(2400, 0.12), 0.7);
  v.tone({ freq: vary(420, 0.15), freqEnd: 250, dur: 0.018, gain: 0.25 });
}

function buildSwitch(v: Voice): void {
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(2600, 0.2), q: 0.6, attack: 0.035, dur: 0.09, gain: 0.35 });
  v.noise({ color: 'white', filter: 'highpass', freq: 5000, at: 0.03, attack: 0.02, dur: 0.05, gain: 0.12 });
  const at = rand(0.085, 0.11);
  v.click(at, vary(2100, 0.12), 0.55, 0.014);
  v.tone({ wave: 'triangle', freq: vary(1300, 0.15), at, dur: 0.035, gain: 0.12 });
}

function buildTorchIgnite(v: Voice): void {
  v.tone({ freq: vary(165, 0.1), freqEnd: 68, dur: 0.07, gain: 0.8 });
  v.noise({ color: 'pink', filter: 'lowpass', freq: vary(750, 0.15), dur: 0.07, gain: 0.8 });
  // Hiss swelling in; the torch loop takes over from here.
  v.noise({
    color: 'white',
    filter: 'bandpass',
    freq: vary(4200, 0.15),
    q: 0.7,
    at: 0.02,
    attack: 0.12,
    hold: 0.08,
    dur: 0.28,
    gain: 0.35,
  });
}

function buildGrab(v: Voice): void {
  v.noise({ color: 'white', filter: 'bandpass', freq: vary(1500, 0.2), q: 1.5, dur: 0.014, gain: 0.5 });
  v.tone({ freq: vary(520, 0.15), freqEnd: 360, dur: 0.022, gain: 0.3 });
}

function buildThrow(v: Voice): void {
  v.noise({
    color: 'pink',
    filter: 'bandpass',
    freq: vary(380, 0.15),
    freqEnd: vary(1400, 0.15),
    sweep: 0.1,
    q: 0.9,
    attack: 0.045,
    dur: 0.13,
    gain: 0.8,
  });
}

const WEAPONS: Record<WeaponSound, WeaponDef> = {
  pistol: { level: 0.4, send: 0.35, rolloff: 0.15, build: buildPistol },
  shotgun: { level: 0.4, send: 0.45, rolloff: 0.15, build: buildShotgun },
  shotgun_pump: { level: 0.4, send: 0.08, rolloff: 1, build: buildShotgunPump },
  rocket_launch: { level: 0.6, send: 0.3, rolloff: 0.3, build: buildRocketLaunch },
  hammer_swing: { level: 0.3, send: 0.03, rolloff: 1, build: buildHammerSwing },
  hammer_hit: { level: 0.45, send: 0.15, rolloff: 0.6, build: buildHammerHit },
  charge_place: { level: 0.4, send: 0.05, rolloff: 1, build: buildChargePlace },
  charge_beep: { level: 0.25, send: 0.04, rolloff: 0.8, build: buildChargeBeep },
  detonator: { level: 0.4, send: 0.05, rolloff: 1, build: buildDetonator },
  reload: { level: 0.4, send: 0.05, rolloff: 1, build: buildReload },
  empty: { level: 0.42, send: 0.03, rolloff: 1, build: buildEmpty },
  switch: { level: 0.28, send: 0.03, rolloff: 1, build: buildSwitch },
  torch_ignite: { level: 0.4, send: 0.08, rolloff: 1, build: buildTorchIgnite },
  grab: { level: 0.22, send: 0.02, rolloff: 1, build: buildGrab },
  throw: { level: 0.3, send: 0.03, rolloff: 1, build: buildThrow },
};

// ───────────────────────────────────────────────────────────────────────── recipes: impacts

/** k: clamped intensity. bright / len: timbre and length multipliers derived from it. */
type ImpactBuilder = (v: Voice, k: number, bright: number, len: number) => void;

interface ImpactDef {
  level: number;
  send: number;
  build: ImpactBuilder;
}

const impactLevel = (k: number): number => 0.25 + 0.75 * Math.pow(Math.min(k, 1), 0.8) + 0.3 * Math.max(0, k - 1);
const impactBright = (k: number): number => 0.65 + 0.5 * Math.min(k, 1.5);
const impactLength = (k: number): number => 0.75 + 0.5 * Math.min(k, 2);
const IMPACT_ROLLOFF = 0.8;

const impactConcrete: ImpactBuilder = (v, k, bright, len) => {
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(260 + 420 * bright, 0.15), dur: 0.1 * len, gain: 1 });
  v.noise({ color: 'white', filter: 'bandpass', freq: vary(1400 * bright, 0.2), q: 0.9, dur: 0.04 * len, gain: 0.6 });
  if (k > 0.3) v.tone({ freq: vary(115, 0.12), freqEnd: 52, dur: 0.11 * len, gain: 0.55 * Math.min(k, 1.6) });
  if (k > 0.55) {
    v.ticks({ color: 'pink', filter: 'highpass', freq: 1800, spread: 0.4, at: 0.02, dur: 0.14 * len, gain: 0.3, rate: 45, tau: 0.006 });
  }
};

const impactBrick: ImpactBuilder = (v, k, bright, len) => {
  const clackHz = vary(620, 0.18);
  v.noise({ color: 'pink', filter: 'lowpass', freq: vary(520 + 650 * bright, 0.15), dur: 0.065 * len, gain: 0.9 });
  v.noise({ color: 'white', filter: 'bandpass', freq: vary(2100 * bright, 0.2), q: 1.2, dur: 0.028 * len, gain: 0.7 });
  v.tone({ wave: 'triangle', freq: clackHz, freqEnd: clackHz * 0.78, dur: 0.03 * len, gain: 0.45 });
  v.tone({ wave: 'triangle', freq: clackHz * 1.52, dur: 0.02 * len, gain: 0.22 });
  if (k > 0.5) v.tone({ freq: vary(140, 0.1), freqEnd: 70, dur: 0.08 * len, gain: 0.4 * Math.min(k, 1.5) });
};

const impactWood: ImpactBuilder = (v, k, bright, len) => {
  // Heavier hits excite a larger piece of timber: lower knock.
  const knock = clamp(rand(200, 500) * (1.12 - 0.22 * Math.min(k, 1.5)), 200, 500);
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(1100 * bright, 0.2), q: 1.6, dur: 0.032 * len, gain: 0.8 });
  v.tone({ freq: knock, freqEnd: knock * 0.86, dur: 0.075 * len, gain: 0.9 });
  v.tone({ freq: knock * vary(2.32, 0.06), dur: 0.035 * len, gain: 0.28 });
  if (k > 0.65) {
    const dur = 0.16 + 0.12 * Math.min(k, 2);
    v.ticks({ color: 'white', filter: 'bandpass', freq: 2800, q: 1.2, spread: 0.5, at: 0.015, dur, gain: 0.4, rate: 55, tau: 0.004 });
  }
};

const impactMetal: ImpactBuilder = (v, k, bright, len) => {
  const count = 4 + (k > 0.45 ? 1 : 0) + (k > 1 ? 1 : 0);
  const base = rand(380, 880) / (1 + 0.28 * Math.min(k, 2));
  v.partials({ base, count, ring: 0.16 + 0.62 * Math.min(k, 2), gain: 0.34, bright, shimmer: k > 0.5 });
  v.noise({ color: 'white', filter: 'highpass', freq: 3500, attack: 0.0004, dur: 0.008, gain: 0.7 });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(2200 * bright, 0.2), q: 1.1, dur: 0.03 * len, gain: 0.5 });
  if (k > 0.6) v.tone({ freq: vary(120, 0.1), freqEnd: 60, dur: 0.07, gain: 0.35 });
};

const impactGlass: ImpactBuilder = (v, k, _bright, len) => {
  v.noise({ color: 'white', filter: 'highpass', freq: 5000, attack: 0.0004, dur: 0.01, gain: 0.8 });
  v.tone({ freq: vary(1500, 0.2), dur: 0.035 * len, gain: 0.35 });
  const pings = 2 + Math.round(Math.min(k, 1.5) * 1.6);
  for (let i = 0; i < pings; i++) {
    v.tone({ wave: i % 2 ? 'triangle' : 'sine', freq: logRand(2600, 7200), at: rand(0, 0.012), dur: rand(0.05, 0.13) * len, gain: 0.22 });
  }
};

const impactDirt: ImpactBuilder = (v, k, _bright, len) => {
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(270, 0.15), attack: 0.003, dur: 0.11 * len, gain: 1 });
  v.tone({ freq: vary(82, 0.12), freqEnd: 44, attack: 0.003, dur: 0.1 * len, gain: 0.5 * Math.min(k, 1.5) });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(700, 0.2), q: 0.5, attack: 0.004, dur: 0.055 * len, gain: 0.25 });
};

const impactFoliage: ImpactBuilder = (v, _k, _bright, len) => {
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(3200, 0.2), q: 0.5, attack: 0.02, dur: 0.15 * len, gain: 0.6 });
  v.ticks({ color: 'white', filter: 'highpass', freq: 4000, spread: 0.3, dur: 0.16 * len, gain: 0.3, rate: 50, tau: 0.004 });
};

const impactPlaster: ImpactBuilder = (v, _k, bright, len) => {
  v.noise({ color: 'white', filter: 'bandpass', freq: vary(1700 * bright, 0.2), q: 0.7, dur: 0.045 * len, gain: 0.7 });
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(420, 0.15), dur: 0.055 * len, gain: 0.6 });
  v.ticks({ color: 'pink', filter: 'highpass', freq: 1200, spread: 0.5, at: 0.01, dur: 0.2 * len, gain: 0.4, rate: 60, tau: 0.007 });
};

const impactRubber: ImpactBuilder = (v, _k, _bright, len) => {
  v.tone({ freq: vary(132, 0.12), freqEnd: 70, sweep: 0.06, attack: 0.003, dur: 0.12 * len, gain: 1 });
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(350, 0.15), attack: 0.002, dur: 0.055 * len, gain: 0.5 });
  v.tone({ wave: 'triangle', freq: vary(185, 0.12), freqEnd: 108, attack: 0.004, dur: 0.085 * len, gain: 0.22 });
};

const IMPACTS: Record<SurfaceKind, ImpactDef> = {
  concrete: { level: 0.45, send: 0.14, build: impactConcrete },
  brick: { level: 0.4, send: 0.12, build: impactBrick },
  wood: { level: 0.42, send: 0.12, build: impactWood },
  metal: { level: 0.38, send: 0.2, build: impactMetal },
  glass: { level: 0.5, send: 0.15, build: impactGlass },
  dirt: { level: 0.5, send: 0.05, build: impactDirt },
  foliage: { level: 0.3, send: 0.03, build: impactFoliage },
  plaster: { level: 0.45, send: 0.08, build: impactPlaster },
  rubber: { level: 0.4, send: 0.05, build: impactRubber },
};

// ───────────────────────────────────────────────────────────────────────── recipes: destruction

// Voice levels and rolloffs of the queued one-shots: needed to rank a request before it is built.
const shatterLevel = (size: number): number => 0.65 + 0.35 * size;
const explosionLevel = (power: number): number => 0.45 + 0.65 * Math.min(power, 1.5);
const collapseLevel = (m: number): number => 0.55 + 0.65 * m;
/** Large collapses carry much further than a few loose bricks. */
const collapseRolloff = (m: number): number => 0.8 - 0.4 * m;
const creakLevel = (intensity: number): number => 0.3 + 0.45 * intensity;
const SHATTER_ROLLOFF = 0.8;
const EXPLOSION_ROLLOFF = 0.32;
const CREAK_ROLLOFF = 0.7;

/** size: 0..1 share of a pane that broke (clamped by the caller). */
function buildShatter(v: Voice, size: number): void {
  const dur = 0.4 + 0.6 * size;
  const count = Math.round(10 + 30 * size);
  v.noise({ color: 'white', filter: 'highpass', freq: vary(2500, 0.15), attack: 0.0004, dur: 0.03, gain: 1.3 });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(1200, 0.2), q: 1, dur: 0.05, gain: 0.9 });
  v.pings({ dur, count, streams: 3 + Math.round(5 * size), low: 2000, high: 9000, gain: 0.4 });
  // Sparkle: a dense spray of ticks over a thin bed of hiss.
  v.ticks({
    color: 'white',
    filter: 'highpass',
    freq: 6000,
    spread: 0.25,
    at: 0.01,
    dur: dur * 0.9,
    gain: 0.4,
    rate: 50 + 60 * size,
    tau: 0.005,
  });
  v.noise({
    color: 'white',
    filter: 'bandpass',
    freq: vary(5200, 0.15),
    q: 0.8,
    at: 0.01,
    attack: 0.015,
    dur: dur * 0.7,
    gain: 0.18,
  });
}

/**
 * far: 0 next to the listener, 1 well beyond ~40 m. The air filter already dulls a distant
 * blast; `far` additionally trades the crack and debris for a longer rolling rumble, so
 * what arrives is a thump and a tail rather than a quiet copy of the close-up sound.
 */
function buildExplosion(v: Voice, power: number, far: number): void {
  const near = 1 - far;
  const body = Math.min(power, 1.5);

  // Crack.
  v.noise({
    color: 'white',
    filter: 'highpass',
    freq: vary(1300, 0.15),
    freqEnd: 400,
    attack: 0.0004,
    dur: 0.08,
    gain: 1.3 * (0.15 + 0.85 * near),
  });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(800, 0.2), q: 0.6, dur: 0.14, gain: 0.4 + 0.6 * near });

  // Sub-bass body, plus a punch an octave up that small speakers can actually reproduce.
  v.tone({ freq: vary(90, 0.08), freqEnd: 28, sweep: 0.3 + 0.15 * body, dur: 0.8 + 0.4 * body, gain: 1.4 });
  v.tone({ freq: vary(170, 0.1), freqEnd: 48, sweep: 0.12, dur: 0.3, gain: 0.9 });

  // Roar: broadband noise under a low-pass that closes over about a second.
  const roar = 1 + 0.4 * body;
  v.noise({
    color: 'brown',
    filter: 'lowpass',
    freq: (2600 + 2200 * body) * (0.3 + 0.7 * near),
    freqEnd: 80,
    sweep: roar,
    attack: 0.008,
    dur: roar + 0.3,
    gain: 1.3,
  });
  v.noise({
    color: 'pink',
    filter: 'lowpass',
    freq: 5200 + 2500 * body,
    freqEnd: 180,
    sweep: roar * 0.8,
    attack: 0.008,
    dur: roar * 0.8,
    gain: 0.7 * (0.3 + 0.7 * near),
  });

  // Debris crackle.
  v.ticks({
    color: 'white',
    filter: 'bandpass',
    freq: 2300,
    q: 0.8,
    spread: 0.6,
    at: 0.09,
    dur: 1 + Math.min(power, 1),
    gain: 0.45 * (0.1 + 0.9 * near),
    rate: 34,
    tau: 0.007,
  });

  // Rolling tail.
  v.rumble({
    color: 'brown',
    freq: 170,
    at: 0.05,
    dur: 1.4 + 1.4 * far + 0.5 * body,
    gain: 0.5 + 0.7 * far,
    depth: 0.55,
    shape: rollShape,
  });
}

/** m: 0 (≈100 kg, a rattle) … 1 (≈100 t, a roar), from log10 of the detached mass. */
function buildCollapse(v: Voice, m: number): void {
  const dur = 1.5 + 2.5 * m;

  // Rumble bed under a slowly wandering low-pass; big collapses add a mid-range roar.
  v.rumble({
    color: 'brown',
    freq: 260 + 1000 * m,
    freqLo: 110 + 60 * m,
    dur,
    gain: 0.5 + m,
    depth: 0.35,
    shape: swellShape,
  });
  if (m > 0.3) {
    v.rumble({
      color: 'pink',
      filter: 'bandpass',
      freq: 700,
      freqLo: 280,
      q: 0.5,
      dur: dur * 0.9,
      gain: 0.9 * (m - 0.2),
      depth: 0.4,
      shape: swellShape,
    });
  }
  // Sub rumble, doubled an octave up so it survives small speakers.
  if (m > 0.12) {
    const sub = vary(50 - 18 * m, 0.06);
    v.drone({ freq: sub, dur, gain: 0.25 + m, depth: 0.6, shape: swellShape });
    v.drone({ freq: sub * 2.02, dur: dur * 0.9, gain: 0.12 + 0.45 * m, depth: 0.6, shape: swellShape });
  }

  // Crunches and cracks; their density follows the same swell as the rumble.
  v.ticks({
    color: 'pink',
    filter: 'bandpass',
    freq: 850,
    q: 0.7,
    spread: 0.6,
    dur: dur * 0.95,
    gain: 1.1 + 0.2 * m,
    rate: 14 + 28 * m,
    tau: 0.018,
    shape: swellShape,
  });
  v.ticks({
    color: 'white',
    filter: 'highpass',
    freq: 1900,
    spread: 0.4,
    dur: dur * 0.85,
    gain: 0.8 + 0.1 * m,
    rate: 10 + 24 * m,
    tau: 0.006,
    shape: swellShape,
  });

  // Big masses land in pieces: a few heavy thuds inside the rumble.
  if (m > 0.4) {
    const thuds = m > 0.75 ? 3 : 2;
    for (let i = 0; i < thuds; i++) {
      const at = dur * rand(0.1, 0.6);
      v.tone({ freq: vary(85, 0.15), freqEnd: 36, sweep: 0.12, at, dur: 0.4 + 0.3 * m, gain: 0.9 * m });
      v.noise({ color: 'brown', filter: 'lowpass', freq: vary(300, 0.2), at, dur: 0.3, gain: 0.9 * m });
    }
  }
}

function buildCreak(v: Voice, intensity: number): void {
  const dur = 0.6 + 1.2 * intensity;
  const t = v.t0;
  const end = t + dur;
  const f0 = rand(60, 180) * v.pitch;
  const bodyHz = rand(380, 900) * v.pitch;

  // Two narrow resonances over a rough source: the harmonics sweeping through them as the
  // pitch slips are what reads as stressed steel.
  const body = v.filter('bandpass', bodyHz, rand(6, 10));
  const ring = v.filter('bandpass', bodyHz * rand(2.4, 3.1), 9);
  const growl = v.filter('lowpass', 320, 0.7);
  // A high-Q band-pass passes one harmonic of the saw at a time, hence the large make-up gain.
  const resonant = v.gain(5);
  const growlLevel = v.gain(0.5);
  const amp = v.gain(0);
  body.connect(resonant);
  ring.connect(resonant);
  resonant.connect(amp);
  growl.connect(growlLevel);
  growlLevel.connect(amp);
  amp.connect(v.input);

  const saw = v.osc('sawtooth', f0, t, end + 0.05);
  const fifth = v.osc('triangle', f0 * 1.498, t, end + 0.05);
  const fifthLevel = v.gain(0.6);
  saw.connect(body);
  saw.connect(ring);
  saw.connect(growl);
  fifth.connect(fifthLevel);
  fifthLevel.connect(body);
  fifthLevel.connect(ring);

  // Both oscillators follow one irregular pitch path that drifts as the load shifts.
  const drift = rand(-0.12, 0.25);
  saw.frequency.setValueAtTime(f0, t);
  fifth.frequency.setValueAtTime(f0 * 1.498, t);
  for (let at = t; at < end; ) {
    at = Math.min(end, at + rand(0.06, 0.22));
    const f = f0 * rand(0.86, 1.16) * (1 + (drift * (at - t)) / dur);
    saw.frequency.linearRampToValueAtTime(f, at);
    fifth.frequency.linearRampToValueAtTime(f * 1.498, at);
  }
  wobble(body.frequency, t, dur, bodyHz * 0.8, bodyHz * 1.3, 0.1, 0.3, null);
  wobble(amp.gain, t, dur, 0.25, 1, 0.04, 0.16, groanShape);

  // Stick-slip clicks.
  v.ticks({
    color: 'white',
    filter: 'bandpass',
    freq: 2400,
    q: 2,
    spread: 0.5,
    dur: dur * 0.9,
    gain: 0.3,
    rate: 10 + 16 * intensity,
    tau: 0.003,
    shape: groanShape,
  });
}

// ───────────────────────────────────────────────────────────────────────── recipes: movement

type StepBuilder = (v: Voice) => void;

/** Hard mineral floors share one recipe; `tone` raises the tap for brick. */
function hardStep(v: Voice, tone: number): void {
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(430 * tone, 0.15), attack: 0.002, dur: 0.055, gain: 0.9 });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(1100 * tone, 0.2), q: 1, dur: 0.022, gain: 0.45 });
  v.tone({ freq: vary(150 * tone, 0.12), freqEnd: 88, dur: 0.045, gain: 0.35 });
  v.noise({ color: 'white', filter: 'bandpass', freq: vary(3000, 0.2), q: 0.6, at: 0.01, attack: 0.012, dur: 0.05, gain: 0.08 });
}

const STEPS: Record<SurfaceKind, StepBuilder> = {
  concrete: (v) => hardStep(v, 1),
  brick: (v) => hardStep(v, 1.25),
  wood: (v) => {
    const knock = rand(160, 230);
    v.tone({ freq: knock, freqEnd: knock * 0.8, attack: 0.002, dur: 0.075, gain: 0.8 });
    v.tone({ freq: knock * vary(2.4, 0.08), dur: 0.03, gain: 0.2 });
    v.noise({ color: 'pink', filter: 'bandpass', freq: vary(700, 0.2), q: 1.2, dur: 0.03, gain: 0.5 });
  },
  metal: (v) => {
    v.partials({ base: rand(480, 760), count: 3, ring: rand(0.1, 0.18), gain: 0.22 });
    v.click(0, vary(2500, 0.15), 0.3, 0.01);
    v.noise({ color: 'brown', filter: 'lowpass', freq: 320, dur: 0.05, gain: 0.5 });
  },
  glass: (v) => {
    v.ticks({ color: 'white', filter: 'highpass', freq: 3500, spread: 0.3, dur: 0.11, gain: 0.7, rate: 110, tau: 0.004 });
    v.tone({ freq: logRand(3000, 6000), at: rand(0, 0.03), dur: 0.04, gain: 0.07 });
    v.tone({ wave: 'triangle', freq: logRand(3000, 6500), at: rand(0.02, 0.06), dur: 0.03, gain: 0.05 });
    v.noise({ color: 'brown', filter: 'lowpass', freq: 400, dur: 0.055, gain: 0.5 });
  },
  dirt: (v) => {
    v.noise({ color: 'brown', filter: 'lowpass', freq: vary(360, 0.15), attack: 0.004, dur: 0.075, gain: 0.8 });
    v.ticks({ color: 'pink', filter: 'bandpass', freq: 1500, q: 0.6, spread: 0.4, dur: 0.09, gain: 0.3, rate: 70, tau: 0.006 });
  },
  foliage: (v) => {
    v.noise({ color: 'pink', filter: 'highpass', freq: vary(2500, 0.2), attack: 0.015, dur: 0.11, gain: 0.45 });
    v.ticks({ color: 'white', filter: 'highpass', freq: 4000, spread: 0.3, dur: 0.12, gain: 0.25, rate: 70, tau: 0.004 });
    v.noise({ color: 'brown', filter: 'lowpass', freq: 260, attack: 0.004, dur: 0.06, gain: 0.45 });
  },
  plaster: (v) => {
    v.noise({ color: 'brown', filter: 'lowpass', freq: vary(450, 0.15), dur: 0.05, gain: 0.9 });
    v.ticks({ color: 'pink', filter: 'highpass', freq: 1500, spread: 0.4, dur: 0.08, gain: 0.5, rate: 80, tau: 0.005 });
  },
  rubber: (v) => {
    v.tone({ freq: vary(125, 0.1), freqEnd: 80, attack: 0.004, dur: 0.07, gain: 0.7 });
    v.noise({ color: 'brown', filter: 'lowpass', freq: 300, attack: 0.003, dur: 0.05, gain: 0.4 });
  },
};

/** Added under the surface step when landing: body weight plus a rustle of gear. */
function buildLandThump(v: Voice, weight: number): void {
  v.tone({ freq: vary(96, 0.1), freqEnd: 42, sweep: 0.09, dur: 0.16, gain: weight });
  v.noise({ color: 'brown', filter: 'lowpass', freq: vary(210, 0.15), attack: 0.003, dur: 0.17, gain: 0.9 });
  v.noise({ color: 'pink', filter: 'bandpass', freq: vary(1800, 0.2), q: 0.5, at: 0.01, attack: 0.02, dur: 0.12, gain: 0.14 });
}

// ───────────────────────────────────────────────────────────────────────── recipes: UI

interface UiDef {
  level: number;
  build: (v: Voice) => void;
}

const UI: Record<UiSound, UiDef> = {
  hover: {
    level: 0.05,
    build: (v) => {
      v.tone({ freq: 1900, attack: 0.002, dur: 0.014, gain: 0.5 });
      v.noise({ color: 'white', filter: 'bandpass', freq: 3200, q: 2, dur: 0.006, gain: 0.25 });
    },
  },
  click: {
    level: 0.1,
    build: (v) => {
      v.click(0, 2600, 0.8, 0.01);
      v.tone({ freq: 1250, freqEnd: 880, dur: 0.02, gain: 0.5 });
    },
  },
  back: {
    level: 0.12,
    build: (v) => {
      v.click(0, 1300, 0.7, 0.014);
      v.tone({ freq: 520, freqEnd: 330, dur: 0.045, gain: 0.6 });
    },
  },
  start: {
    level: 0.12,
    build: (v) => {
      // Two relay-like notes a fifth apart; the second lands on a low thunk.
      v.click(0, 1800, 0.5);
      v.tone({ wave: 'triangle', freq: 330, attack: 0.003, dur: 0.09, gain: 0.7 });
      v.tone({ freq: 660, dur: 0.06, gain: 0.15 });
      v.click(0.095, 2400, 0.6);
      v.tone({ wave: 'triangle', freq: 495, at: 0.095, attack: 0.003, dur: 0.2, gain: 0.8 });
      v.tone({ freq: 990, at: 0.095, dur: 0.12, gain: 0.18 });
      v.tone({ freq: 110, freqEnd: 70, at: 0.095, dur: 0.1, gain: 0.5 });
    },
  },
  success: {
    level: 0.16,
    build: (v) => {
      v.tone({ freq: 660, attack: 0.002, dur: 0.07, gain: 0.6 });
      v.tone({ wave: 'triangle', freq: 1320, dur: 0.05, gain: 0.12 });
      v.tone({ freq: 990, at: 0.075, attack: 0.002, dur: 0.22, gain: 0.7 });
      v.tone({ wave: 'triangle', freq: 1980, at: 0.075, dur: 0.12, gain: 0.12 });
      v.click(0.075, 3000, 0.25, 0.006);
    },
  },
  fail: {
    level: 0.16,
    build: (v) => {
      const dull = v.filter('lowpass', 1100, 0.8);
      dull.connect(v.input);
      v.click(0, 1500, 0.4);
      v.tone({ wave: 'sawtooth', freq: 196, attack: 0.003, hold: 0.03, dur: 0.09, gain: 0.5, into: dull });
      v.tone({ wave: 'sawtooth', freq: 147, at: 0.1, attack: 0.003, hold: 0.04, dur: 0.16, gain: 0.55, into: dull });
    },
  },
  tick: {
    level: 0.11,
    build: (v) => {
      v.click(0, 3400, 0.8, 0.01);
      v.tone({ freq: 2200, dur: 0.01, gain: 0.3 });
    },
  },
};

// ───────────────────────────────────────────────────────────────────────── recipes: ambience

function buildBird(v: Voice): void {
  const base = rand(2800, 5200);
  const notes = 2 + Math.floor(rand(0, 4));
  let at = 0;
  for (let i = 0; i < notes; i++) {
    const len = rand(0.04, 0.09);
    const freq = base * rand(0.85, 1.2);
    const bend = Math.random() < 0.6 ? rand(1.2, 1.5) : rand(0.65, 0.85);
    v.tone({ freq, freqEnd: freq * bend, sweep: len, at, attack: 0.008, dur: len, gain: 0.5 });
    at += len + rand(0.04, 0.12);
  }
}

function buildFarClank(v: Voice): void {
  const hits = Math.random() < 0.35 ? 2 : 1;
  for (let i = 0; i < hits; i++) {
    const at = i * rand(0.18, 0.35);
    v.partials({ at, base: rand(240, 520), count: 4, ring: rand(0.35, 0.7), gain: 0.3 });
    v.noise({ color: 'pink', filter: 'bandpass', freq: 1500, q: 1, at, dur: 0.04, gain: 0.5 });
  }
}

function buildFarVehicle(v: Voice): void {
  const dur = rand(5, 9);
  v.rumble({ color: 'brown', freq: rand(160, 240), freqLo: 90, dur, gain: 0.9, depth: 0.25, shape: passShape });
  const dull = v.filter('lowpass', 190, 0.7);
  dull.connect(v.input);
  const engine = v.drone({ wave: 'sawtooth', freq: rand(42, 68), dur, gain: 0.3, depth: 0.2, shape: passShape, into: dull });
  const f = engine.frequency.value;
  engine.frequency.setValueAtTime(f * 1.04, v.t0);
  engine.frequency.linearRampToValueAtTime(f * 0.93, v.t0 + dur);
}

/** Wind on both sides, a thin layer of moving air, city rumble and mains hum. */
function buildAmbienceBed(v: Voice): void {
  for (const side of [-0.6, 0.6]) {
    const wind = v.bed({ color: 'pink', filter: 'lowpass', freq: 420, gain: 0.06, into: v.placed(side) });
    const level = wind.gain.gain.value;
    // Incommensurate LFO pairs: gusts never line up between the two sides or repeat audibly.
    v.lfo(rand(0.05, 0.09), 170, wind.filter.frequency);
    v.lfo(rand(0.11, 0.17), 60, wind.filter.frequency);
    v.lfo(rand(0.07, 0.12), level * 0.45, wind.gain.gain);
    v.lfo(rand(0.021, 0.04), level * 0.3, wind.gain.gain);
  }
  const air = v.bed({ color: 'white', filter: 'bandpass', freq: 1900, q: 0.5, gain: 0.012 });
  v.lfo(rand(0.04, 0.07), air.gain.gain.value * 0.6, air.gain.gain);
  v.bed({ color: 'brown', filter: 'lowpass', freq: 110, gain: 0.05 });

  const hum: readonly (readonly [number, number])[] = [
    [50, 0.01],
    [100, 0.007],
    [150, 0.003],
  ];
  for (const [freq, gain] of hum) {
    const o = v.osc('sine', freq, v.t0, Infinity);
    const g = v.gain(gain);
    o.connect(g);
    g.connect(v.input);
  }
}

// ───────────────────────────────────────────────────────────────────────── loops

interface LoopHost {
  readonly ctx: AudioContext;
  moveVoice(voice: Voice, pos: Vec3Like): void;
  retire(loop: Loop, fadeSeconds: number): void;
}

interface PitchTrack {
  param: AudioParam;
  base: number;
  power: number;
}

/** Fire crackle channel: a silent noise band that update() opens for a few milliseconds at a time. */
interface Crackle {
  gain: AudioParam;
  freq: AudioParam;
  unit: number;
  rate: number;
  next: number;
}

class Loop implements LoopHandle {
  crackle: Crackle | null = null;
  private readonly tracks: PitchTrack[] = [];
  private pitch = 1;
  /** Level the voice is currently heading for; it starts silent. */
  private target = 0;
  private stopped = false;

  constructor(
    private readonly host: LoopHost,
    readonly voice: Voice,
    private readonly level: number,
  ) {}

  /** Makes `param` follow setPitch as base · pitch^power, from its current value. */
  follow(param: AudioParam, power = 1): void {
    this.tracks.push({ param, base: param.value, power });
  }

  setGain(gain: number, rampSeconds = 0.05): void {
    if (this.stopped) return;
    try {
      const target = this.level * clamp(finite(gain, 1), 0, 4);
      // Typically called every frame with an unchanged value.
      if (target === this.target) return;
      this.target = target;
      const ramp = clamp(finite(rampSeconds, 0.05), 0.005, 30);
      this.voice.fade(target, this.host.ctx.currentTime, ramp);
    } catch {
      // a loop handle must never throw into the game loop
    }
  }

  setPitch(pitch: number): void {
    if (this.stopped) return;
    try {
      const p = clamp(finite(pitch, 1), 0.25, 4);
      if (Math.abs(p - this.pitch) < 0.002) return;
      this.pitch = p;
      const now = this.host.ctx.currentTime;
      for (const track of this.tracks) track.param.setTargetAtTime(track.base * Math.pow(p, track.power), now, 0.04);
    } catch {
      // see setGain
    }
  }

  setPos(pos: Vec3Like): void {
    if (this.stopped || !isPoint(pos)) return;
    try {
      this.host.moveVoice(this.voice, pos);
    } catch {
      // see setGain
    }
  }

  stop(fadeSeconds = 0.08): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.host.retire(this, clamp(finite(fadeSeconds, 0.08), 0.01, 30));
    } catch {
      // see setGain
    }
  }

  /** Schedules crackles a little ahead of `now`; called once per frame for fire loops. */
  scheduleCrackles(now: number): void {
    const c = this.crackle;
    if (!c || this.stopped) return;
    if (c.next < now) c.next = now + Math.random() * 0.05;
    const horizon = now + 0.15;
    while (c.next < horizon) {
      const t = c.next;
      const pop = Math.random() < 0.12;
      c.gain.setValueAtTime(c.unit * (pop ? rand(0.6, 1) : rand(0.08, 0.4)), t);
      c.gain.setTargetAtTime(0, t, pop ? rand(0.008, 0.02) : rand(0.002, 0.007));
      c.freq.setValueAtTime(pop ? rand(900, 1800) : rand(1600, 4800), t);
      c.next = t + Math.max(0.002, poissonGap(c.rate));
    }
  }
}

const NULL_LOOP: LoopHandle = Object.freeze({
  setGain(): void {},
  setPitch(): void {},
  setPos(): void {},
  stop(): void {},
});

interface LoopDef {
  level: number;
  send: number;
  rolloff: number;
  build: (v: Voice, loop: Loop) => void;
}

function buildTorchLoop(v: Voice, loop: Loop): void {
  const hiss = v.bed({ color: 'white', filter: 'bandpass', freq: 3800, q: 0.6, gain: 0.3 });
  const roar = v.bed({ color: 'pink', filter: 'bandpass', freq: 480, q: 0.8, gain: 0.7 });
  const body = v.bed({ color: 'brown', filter: 'lowpass', freq: 220, gain: 0.35 });
  const roarLevel = roar.gain.gain.value;
  v.lfo(rand(11, 14), roarLevel * 0.22, roar.gain.gain);
  v.lfo(rand(3, 4.5), roarLevel * 0.14, roar.gain.gain);
  v.lfo(rand(17, 23), hiss.gain.gain.value * 0.12, hiss.gain.gain);
  loop.follow(hiss.filter.frequency, 0.6);
  loop.follow(roar.filter.frequency, 1);
  loop.follow(body.filter.frequency, 0.8);
}

function buildRocketLoop(v: Voice, loop: Loop): void {
  const roar = v.bed({ color: 'brown', filter: 'lowpass', freq: 520, gain: 1 });
  const mid = v.bed({ color: 'pink', filter: 'bandpass', freq: 1150, q: 0.5, gain: 0.6 });
  const hiss = v.bed({ color: 'white', filter: 'highpass', freq: 4000, gain: 0.15 });
  v.lfo(rand(21, 27), roar.gain.gain.value * 0.3, roar.gain.gain);
  v.lfo(rand(4, 6), mid.gain.gain.value * 0.25, mid.gain.gain);
  loop.follow(roar.filter.frequency, 1);
  loop.follow(mid.filter.frequency, 1);
  loop.follow(hiss.filter.frequency, 0.4);
  loop.follow(roar.source.playbackRate, 0.5);
}

function buildFireLoop(v: Voice, loop: Loop): void {
  const bed = v.bed({ color: 'pink', filter: 'lowpass', freq: 900, gain: 0.35 });
  const low = v.bed({ color: 'brown', filter: 'lowpass', freq: 300, gain: 0.45 });
  v.lfo(rand(2, 4), bed.gain.gain.value * 0.3, bed.gain.gain);
  v.lfo(rand(5, 8), low.gain.gain.value * 0.25, low.gain.gain);
  const crack = v.bed({ color: 'white', filter: 'bandpass', freq: 2200, q: 0.9, gain: 0 });
  loop.crackle = { gain: crack.gain.gain, freq: crack.filter.frequency, unit: crack.unit, rate: 9, next: 0 };
  loop.follow(bed.filter.frequency, 0.7);
  loop.follow(low.filter.frequency, 0.7);
}

function buildEngineLoop(v: Voice, loop: Loop): void {
  const idle = 52 * v.pitch;
  const dull = v.filter('lowpass', 420, 0.9);
  const amp = v.gain(1);
  dull.connect(amp);
  amp.connect(v.input);

  const voices: readonly (readonly [OscillatorType, number, number])[] = [
    ['sawtooth', 1, 0.5],
    // A few cents sharp: the slow beat against the first saw keeps the idle from sounding static.
    ['sawtooth', 1.008, 0.35],
    ['square', 0.5, 0.3],
  ];
  for (const [wave, ratio, gain] of voices) {
    const o = v.osc(wave, idle * ratio, v.t0, Infinity);
    const g = v.gain(gain);
    o.connect(g);
    g.connect(dull);
    loop.follow(o.frequency, 1);
  }
  // Uneven firing: amplitude lumps at a quarter of the crank frequency.
  const lump = v.lfo(idle / 4, 0.3, amp.gain);
  const mech = v.bed({ color: 'pink', filter: 'bandpass', freq: 900, q: 0.7, gain: 0.12 });
  loop.follow(lump.frequency, 1);
  loop.follow(dull.frequency, 0.8);
  loop.follow(mech.filter.frequency, 0.7);
}

const LOOPS: Record<LoopKind, LoopDef> = {
  torch: { level: 0.3, send: 0.04, rolloff: 1.2, build: buildTorchLoop },
  rocket: { level: 0.5, send: 0.1, rolloff: 0.5, build: buildRocketLoop },
  fire: { level: 0.4, send: 0.05, rolloff: 0.9, build: buildFireLoop },
  engine: { level: 0.25, send: 0.05, rolloff: 0.7, build: buildEngineLoop },
};

// ───────────────────────────────────────────────────────────────────────── engine

interface VoiceRequest {
  /** Input gain of the voice; also its loudness estimate before distance. */
  level: number;
  pos: Vec3Like | null;
  delay?: number;
  pitch?: number;
  /** Random pitch spread, default ±4 %. */
  jitter?: number;
  /** Reverb send. */
  send?: number;
  rolloff?: number;
  /** Air-absorption scale in metres (see SpatialAudio.airCutoff); omit for no filter. */
  reach?: number;
  /** Delay the voice by distance / speed of sound. */
  propagate?: boolean;
  /** Never dropped: takes the quietest voice instead, whatever its loudness. */
  priority?: boolean;
  /** Route past the pause duck and the reverb. */
  ui?: boolean;
}

/** Everything that needs a live AudioContext. Created by AudioManager.unlock(). */
class AudioEngine implements VoiceHost, LoopHost {
  readonly nyquist: number;
  readonly noise: Readonly<Record<NoiseColor, AudioBuffer>>;

  private readonly master: GainNode;
  private readonly duck: GainNode;
  private readonly dry: GainNode;
  private readonly reverbIn: GainNode;
  private readonly uiBus: GainNode;

  private readonly voices: Voice[] = [];
  private readonly fires: Loop[] = [];
  private live = 0;
  private paused: boolean;
  private ambience: Voice | null = null;
  private ambienceTimer = 0;
  private reapTimer = 0;
  private readonly scratch: Vec3Like = { x: 0, y: 0, z: 0 };
  private readonly lookahead: number;

  private readonly weaponLimit = new RateLimiter(10, 0.1);
  private readonly uiLimit = new RateLimiter(5, 0.06);
  // The second, longer window keeps a sustained shower of events from holding the burst rate.
  private readonly impacts = new BurstQueue(6, new RateLimiter(6, 0.08), new RateLimiter(18, 0.5));
  private readonly shatters = new BurstQueue(2, new RateLimiter(2, 0.1), new RateLimiter(6, 1));
  private readonly explosions = new BurstQueue(3, new RateLimiter(3, 0.1), new RateLimiter(8, 1));
  private readonly collapses = new BurstQueue(2, new RateLimiter(2, 0.3), new RateLimiter(5, 2));
  private readonly creaks = new BurstQueue(2, new RateLimiter(2, 0.6));

  constructor(
    readonly ctx: AudioContext,
    private readonly spatial: SpatialAudio,
    masterVolume: number,
    paused: boolean,
  ) {
    this.nyquist = ctx.sampleRate / 2;
    // Voices start a little ahead of the clock. An event stamped "now" is already in the past when
    // the audio thread sees it, which clips a few random milliseconds off the front of every
    // envelope: inaudible on a rumble, but 10 dB or more off a click that only lasts 10 ms.
    this.lookahead = clamp(finite(ctx.baseLatency, 0.008) + 0.003, 0.006, 0.02);
    this.paused = paused;
    this.noise = {
      white: makeNoiseBuffer(ctx, 'white'),
      pink: makeNoiseBuffer(ctx, 'pink'),
      brown: makeNoiseBuffer(ctx, 'brown'),
    };

    // Limiter. Browsers add make-up gain to this node (about +3 dB at these settings), which
    // MASTER_TRIM takes back so a full-scale mix stays clear of the converter.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 4;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = masterVolume * MASTER_TRIM;
    limiter.connect(this.master);
    this.master.connect(ctx.destination);

    this.duck = ctx.createGain();
    this.duck.gain.value = paused ? 0 : 1;
    this.duck.connect(limiter);
    this.dry = ctx.createGain();
    this.dry.connect(this.duck);
    this.uiBus = ctx.createGain();
    this.uiBus.connect(limiter);

    const convolver = ctx.createConvolver();
    convolver.normalize = false;
    convolver.buffer = makeImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = REVERB_RETURN;
    this.reverbIn = ctx.createGain();
    this.reverbIn.connect(convolver);
    convolver.connect(wet);
    wet.connect(this.duck);
  }

  // ── mix ──

  setMasterVolume(volume: number): void {
    this.master.gain.setTargetAtTime(volume * MASTER_TRIM, this.ctx.currentTime, 0.03);
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.duck.gain.setTargetAtTime(paused ? 0 : 1, this.ctx.currentTime, paused ? 0.05 : 0.08);
  }

  activeVoices(): number {
    return this.live;
  }

  // ── per frame ──

  update(dt: number): void {
    const now = this.ctx.currentTime;
    this.drain(this.impacts, now, this.playImpact);
    this.drain(this.shatters, now, this.playShatter);
    this.drain(this.explosions, now, this.playExplosion);
    this.drain(this.collapses, now, this.playCollapse);
    this.drain(this.creaks, now, this.playCreak);

    for (let i = 0; i < this.fires.length; i++) this.fires[i].scheduleCrackles(now);

    if (this.ambience && !this.paused) {
      this.ambienceTimer -= dt;
      if (this.ambienceTimer <= 0) {
        this.ambienceTimer = rand(5, 14);
        // Distant colour is the first thing to go when the scene is busy.
        if (this.ctx.state === 'running' && this.live < MAX_VOICES - 8) this.ambientEvent();
      }
    }

    this.reapTimer += dt;
    if (this.reapTimer >= REAP_INTERVAL) {
      this.reapTimer = 0;
      this.reap(now);
    }
  }

  // ── one-shots ──

  weapon(kind: WeaponSound, opts: PlayOpts | undefined): void {
    const def = WEAPONS[kind];
    if (!def) return;
    const now = this.ctx.currentTime;
    if (!this.weaponLimit.ready(now)) return;
    const pos = optPos(opts);
    const v = this.spawn({
      level: def.level * optGain(opts),
      pos,
      delay: optDelay(opts),
      pitch: optPitch(opts),
      // The octave relation inside a beep must survive; everything else gets the usual spread.
      jitter: kind === 'charge_beep' ? 0.012 : 0.04,
      send: def.send,
      rolloff: def.rolloff,
      reach: 40,
      // The player's own (2D) weapon feedback always sounds.
      priority: pos === null,
    });
    if (!v) return;
    this.weaponLimit.mark(now);
    def.build(v);
  }

  impact(surface: SurfaceKind, intensity: number, opts: PlayOpts | undefined): void {
    const k = clamp(finite(intensity, 0.5), 0.03, 3);
    const def = IMPACTS[surface] ?? IMPACTS.concrete;
    this.enqueue(this.impacts, def.level * impactLevel(k) * optGain(opts), IMPACT_ROLLOFF, surface, k, optPos(opts), opts);
  }

  shatter(pos: Vec3Like, size: number): void {
    const s = clamp(finite(size, 0.5), 0.05, 1);
    this.enqueue(this.shatters, shatterLevel(s), SHATTER_ROLLOFF, 'glass', s, isPoint(pos) ? pos : null, undefined);
  }

  explosion(pos: Vec3Like, power: number): void {
    const p = clamp(finite(power, 0.7), 0.1, 2);
    this.enqueue(this.explosions, explosionLevel(p), EXPLOSION_ROLLOFF, 'concrete', p, isPoint(pos) ? pos : null, undefined);
  }

  collapse(pos: Vec3Like, massKg: number): void {
    const m = clamp((Math.log10(Math.max(finite(massKg, 1000), 1)) - 2) / 3, 0, 1);
    this.enqueue(this.collapses, collapseLevel(m), collapseRolloff(m), 'concrete', m, isPoint(pos) ? pos : null, undefined);
  }

  creak(pos: Vec3Like, intensity: number): void {
    const i = clamp(finite(intensity, 0.5), 0, 1);
    this.enqueue(this.creaks, creakLevel(i), CREAK_ROLLOFF, 'metal', i, isPoint(pos) ? pos : null, undefined);
  }

  footstep(surface: SurfaceKind, intensity: number): void {
    const w = clamp(finite(intensity, 0.6), 0.2, 1.5);
    const v = this.spawn({ level: 0.23 * (0.5 + 0.5 * w), pos: null, jitter: 0.07, send: 0.04, priority: true });
    if (v) (STEPS[surface] ?? STEPS.concrete)(v);
  }

  land(surface: SurfaceKind, intensity: number): void {
    const w = clamp(finite(intensity, 0.6), 0.2, 1.5);
    const v = this.spawn({ level: 0.22 * (0.5 + 0.6 * w), pos: null, jitter: 0.06, send: 0.06, priority: true });
    if (!v) return;
    (STEPS[surface] ?? STEPS.concrete)(v);
    buildLandThump(v, w);
  }

  ui(kind: UiSound): void {
    const def = UI[kind];
    if (!def) return;
    const now = this.ctx.currentTime;
    if (!this.uiLimit.ready(now)) return;
    const v = this.spawn({ level: def.level, pos: null, jitter: 0.012, priority: true, ui: true });
    if (!v) return;
    this.uiLimit.mark(now);
    def.build(v);
  }

  // ── loops ──

  loop(kind: LoopKind, opts: PlayOpts | undefined): LoopHandle {
    const def = LOOPS[kind];
    if (!def) return NULL_LOOP;
    // Level 0: the handle fades it in. Loops are owned by their caller, so never stolen.
    const v = this.spawn({
      level: 0,
      pos: optPos(opts),
      delay: optDelay(opts),
      jitter: 0.03,
      send: def.send,
      rolloff: def.rolloff,
      priority: true,
    });
    if (!v) return NULL_LOOP;
    v.stealable = false;
    const loop = new Loop(this, v, def.level);
    def.build(v, loop);
    loop.setPitch(optPitch(opts));
    loop.setGain(optGain(opts), 0.05);
    if (loop.crackle) this.fires.push(loop);
    return loop;
  }

  moveVoice(v: Voice, pos: Vec3Like): void {
    if (v.state === 'dead') return;
    if (v.panner) {
      this.spatial.move(v.panner, pos);
      return;
    }
    // A loop started without a position becomes spatial on its first setPos().
    const panner = this.spatial.acquire(pos, v.rolloff);
    if (!panner) return;
    v.tail.disconnect();
    v.tail.connect(panner);
    panner.connect(this.dry);
    if (v.send) panner.connect(v.send);
    v.panner = panner;
    v.tail = panner;
  }

  retire(loop: Loop, fadeSeconds: number): void {
    const i = this.fires.indexOf(loop);
    if (i >= 0) this.fires.splice(i, 1);
    loop.voice.stealable = true;
    loop.voice.cut(this.ctx.currentTime, fadeSeconds);
  }

  // ── ambience ──

  startAmbience(): void {
    if (this.ambience) return;
    const v = this.spawn({ level: 0, pos: null, jitter: 0.02, priority: true });
    if (!v) return;
    v.stealable = false;
    this.ambience = v;
    this.ambienceTimer = rand(3, 8);
    buildAmbienceBed(v);
    v.fade(AMBIENCE_LEVEL, v.t0, AMBIENCE_FADE_IN);
  }

  stopAmbience(): void {
    const v = this.ambience;
    if (!v) return;
    this.ambience = null;
    v.stealable = true;
    v.cut(this.ctx.currentTime, AMBIENCE_FADE_OUT);
  }

  /** One quiet far-off event somewhere around the listener. */
  private ambientEvent(): void {
    const roll = Math.random();
    const bearing = rand(0, TAU);
    if (roll < 0.4) {
      const pos = this.spatial.placeAround(this.scratch, bearing, rand(18, 40), rand(3, 12));
      const v = this.spawn({ level: 0.35, pos, send: 0.3, reach: 60 });
      if (v) buildBird(v);
    } else if (roll < 0.75) {
      const pos = this.spatial.placeAround(this.scratch, bearing, rand(45, 85), rand(0, 6));
      const v = this.spawn({ level: 0.8, pos, send: 0.5, reach: 25 });
      if (v) buildFarClank(v);
    } else {
      const pos = this.spatial.placeAround(this.scratch, bearing, rand(60, 100), 0);
      const v = this.spawn({ level: 0.9, pos, send: 0.25, reach: 25 });
      if (v) buildFarVehicle(v);
    }
  }

  // ── deferred one-shots ──

  private enqueue(
    q: BurstQueue,
    level: number,
    rolloff: number,
    surface: SurfaceKind,
    amount: number,
    pos: Vec3Like | null,
    opts: PlayOpts | undefined,
  ): void {
    const score = pos ? level * this.spatial.attenuation(this.spatial.distanceTo(pos), rolloff) : level;
    if (score < MIN_AUDIBLE) return;
    const slot = q.claim(score, this.ctx.currentTime);
    if (!slot) return;
    slot.score = score;
    slot.surface = surface;
    slot.amount = amount;
    slot.spatial = pos !== null;
    if (pos) {
      slot.x = pos.x;
      slot.y = pos.y;
      slot.z = pos.z;
    }
    slot.gain = optGain(opts);
    slot.pitch = optPitch(opts);
    slot.delay = optDelay(opts);
  }

  private drain(q: BurstQueue, now: number, play: (r: Pending) => boolean): void {
    if (q.count === 0) return;
    if (now - q.stamp <= QUEUE_STALE) {
      while (q.ready(now)) {
        const r = q.takeLoudest();
        // If the voice pool turns down the loudest request it would turn down the rest too.
        if (!r || !play(r)) break;
        q.mark(now);
      }
    }
    q.clear();
  }

  private posOf(r: Pending): Vec3Like | null {
    if (!r.spatial) return null;
    this.scratch.x = r.x;
    this.scratch.y = r.y;
    this.scratch.z = r.z;
    return this.scratch;
  }

  private readonly playImpact = (r: Pending): boolean => {
    const def = IMPACTS[r.surface] ?? IMPACTS.concrete;
    const k = r.amount;
    const v = this.spawn({
      level: def.level * impactLevel(k) * r.gain,
      pos: this.posOf(r),
      delay: r.delay,
      pitch: r.pitch,
      jitter: 0.06,
      send: def.send + 0.08 * Math.min(k, 1),
      rolloff: IMPACT_ROLLOFF,
      reach: 28,
    });
    if (!v) return false;
    def.build(v, k, impactBright(k), impactLength(k));
    return true;
  };

  private readonly playShatter = (r: Pending): boolean => {
    const v = this.spawn({
      level: shatterLevel(r.amount),
      pos: this.posOf(r),
      send: 0.22,
      rolloff: SHATTER_ROLLOFF,
      reach: 30,
    });
    if (!v) return false;
    buildShatter(v, r.amount);
    return true;
  };

  private readonly playExplosion = (r: Pending): boolean => {
    const pos = this.posOf(r);
    const far = pos ? smoothstep(10, 40, this.spatial.distanceTo(pos)) : 0;
    const v = this.spawn({
      level: explosionLevel(r.amount),
      pos,
      // A far blast is heard mostly through what the surroundings throw back.
      send: 0.55 + 0.3 * far,
      rolloff: EXPLOSION_ROLLOFF,
      reach: 7,
      propagate: true,
    });
    if (!v) return false;
    buildExplosion(v, r.amount, far);
    return true;
  };

  private readonly playCollapse = (r: Pending): boolean => {
    const m = r.amount;
    const v = this.spawn({
      level: collapseLevel(m),
      pos: this.posOf(r),
      send: 0.18,
      rolloff: collapseRolloff(m),
      reach: 14,
      propagate: true,
    });
    if (!v) return false;
    buildCollapse(v, m);
    return true;
  };

  private readonly playCreak = (r: Pending): boolean => {
    const v = this.spawn({
      level: creakLevel(r.amount),
      pos: this.posOf(r),
      jitter: 0.08,
      send: 0.28,
      rolloff: CREAK_ROLLOFF,
      reach: 25,
    });
    if (!v) return false;
    buildCreak(v, r.amount);
    return true;
  };

  // ── voice pool ──

  private spawn(r: VoiceRequest): Voice | null {
    const now = this.ctx.currentTime;
    const pos = r.pos;
    const rolloff = r.rolloff ?? 1;
    const priority = r.priority === true;
    const distance = pos ? this.spatial.distanceTo(pos) : 0;
    const loudness = pos ? r.level * this.spatial.attenuation(distance, rolloff) : r.level;
    if (!priority && loudness < MIN_AUDIBLE) return null;
    if (!this.makeRoom(loudness, priority, now)) return null;

    const delay = this.lookahead + (r.delay ?? 0) + (pos && r.propagate ? this.spatial.propagationDelay(distance) : 0);
    const v = new Voice(this, now + delay, (r.pitch ?? 1) * vary(1, r.jitter ?? 0.04), loudness, distance, rolloff);
    v.input.gain.value = r.level;

    let tail: AudioNode = v.input;
    if (pos) {
      const cutoff = r.reach ? this.spatial.airCutoff(distance, r.reach) : AIR_OPEN_HZ;
      if (cutoff < AIR_BYPASS_HZ) {
        const air = v.filter('lowpass', cutoff, 0.5);
        tail.connect(air);
        tail = air;
      }
      const panner = this.spatial.acquire(pos, rolloff);
      if (panner) {
        tail.connect(panner);
        tail = panner;
        v.panner = panner;
      }
    }
    tail.connect(r.ui ? this.uiBus : this.dry);
    if (r.send && !r.ui) {
      const send = v.gain(r.send);
      tail.connect(send);
      send.connect(this.reverbIn);
      v.send = send;
    }
    v.tail = tail;

    this.voices.push(v);
    this.live++;
    return v;
  }

  /** Frees a slot for a request of the given loudness, or reports that it should be dropped. */
  private makeRoom(loudness: number, priority: boolean, now: number): boolean {
    if (this.live < MAX_VOICES) return true;
    let victim: Voice | null = null;
    let quietest = Infinity;
    for (const v of this.voices) {
      if (v.state !== 'live' || !v.stealable) continue;
      const l = v.loudnessAt(now);
      if (l < quietest) {
        quietest = l;
        victim = v;
      }
    }
    // Nothing stealable means the pool is all loops; only must-play sounds may exceed the cap.
    if (!victim) return priority;
    if (!priority && loudness <= quietest) return false;
    victim.state = 'stolen';
    this.live--;
    victim.cut(now, STEAL_FADE);
    return true;
  }

  /** Disconnects a finished voice. Reached from its sources' `ended` events. */
  release(v: Voice): void {
    if (v.state === 'dead') return;
    if (v.state === 'live') this.live--;
    v.state = 'dead';
    v.dispose();
    if (v.panner) {
      this.spatial.release(v.panner);
      v.panner = null;
    }
    if (v === this.ambience) this.ambience = null;
    const i = this.voices.indexOf(v);
    if (i >= 0) {
      const last = this.voices.pop();
      if (last && last !== v) this.voices[i] = last;
    }
  }

  /** Safety net for `ended` events that never fire (e.g. a source stopped before it started). */
  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (now > v.endTime + REAP_GRACE) this.release(v);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────── public facade

function audioContextConstructor(): typeof AudioContext | null {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Resolves with `work`, or after `ms` if it has not settled: resume() can stay pending without a gesture. */
function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/**
 * IAudio implementation. Holds no Web Audio objects until unlock(); until then every call
 * is a silent no-op, except that master volume, pause state, listener pose and a pending
 * startAmbience() are remembered and applied once the context exists.
 */
export class AudioManager implements IAudio {
  private engine: AudioEngine | null = null;
  private readonly spatial = new SpatialAudio();
  private masterVolume = 1;
  private paused = false;
  private ambienceWanted = false;
  private unsupported = false;
  private unlockedAt = -Infinity;
  private hasRun = false;
  private resumeTimer = 0;
  private warnings = 0;

  async unlock(): Promise<void> {
    try {
      this.unlockedAt = wallClock();
      const engine = this.engine ?? this.boot();
      if (engine && engine.ctx.state !== 'running') await settleWithin(engine.ctx.resume(), RESUME_TIMEOUT_MS);
    } catch (err) {
      this.warn(err);
    }
  }

  setMasterVolume(v: number): void {
    try {
      this.masterVolume = clamp(finite(v, this.masterVolume), 0, 1);
      this.engine?.setMasterVolume(this.masterVolume);
    } catch (err) {
      this.warn(err);
    }
  }

  setPaused(paused: boolean): void {
    try {
      this.paused = paused === true;
      this.engine?.setPaused(this.paused);
    } catch (err) {
      this.warn(err);
    }
  }

  setListener(pos: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    try {
      this.spatial.setListener(pos, forward, up);
    } catch (err) {
      this.warn(err);
    }
  }

  update(dt: number): void {
    try {
      const engine = this.engine;
      if (!engine) return;
      const step = clamp(finite(dt, 0), 0, 1);
      if (engine.ctx.state === 'running') {
        this.hasRun = true;
      } else if (this.hasRun) {
        // Safari interrupts a running context when the tab loses audio focus. Once a context
        // has run it may be resumed without a new gesture, so keep nudging it.
        this.resumeTimer -= step;
        if (this.resumeTimer <= 0) {
          this.resumeTimer = 1;
          void engine.ctx.resume().catch(() => undefined);
        }
      }
      engine.update(step);
    } catch (err) {
      this.warn(err);
    }
  }

  weapon(kind: WeaponSound, opts?: PlayOpts): void {
    try {
      this.playable()?.weapon(kind, opts);
    } catch (err) {
      this.warn(err);
    }
  }

  impact(surface: SurfaceKind, intensity: number, opts?: PlayOpts): void {
    try {
      this.playable()?.impact(surface, intensity, opts);
    } catch (err) {
      this.warn(err);
    }
  }

  shatter(pos: Vec3Like, size: number): void {
    try {
      this.playable()?.shatter(pos, size);
    } catch (err) {
      this.warn(err);
    }
  }

  explosion(pos: Vec3Like, power: number): void {
    try {
      this.playable()?.explosion(pos, power);
    } catch (err) {
      this.warn(err);
    }
  }

  collapse(pos: Vec3Like, massKg: number): void {
    try {
      this.playable()?.collapse(pos, massKg);
    } catch (err) {
      this.warn(err);
    }
  }

  creak(pos: Vec3Like, intensity: number): void {
    try {
      this.playable()?.creak(pos, intensity);
    } catch (err) {
      this.warn(err);
    }
  }

  footstep(surface: SurfaceKind, intensity: number): void {
    try {
      this.playable()?.footstep(surface, intensity);
    } catch (err) {
      this.warn(err);
    }
  }

  land(surface: SurfaceKind, intensity: number): void {
    try {
      this.playable()?.land(surface, intensity);
    } catch (err) {
      this.warn(err);
    }
  }

  ui(kind: UiSound): void {
    try {
      this.playable()?.ui(kind);
    } catch (err) {
      this.warn(err);
    }
  }

  loop(kind: LoopKind, opts?: PlayOpts): LoopHandle {
    try {
      return this.engine?.loop(kind, opts) ?? NULL_LOOP;
    } catch (err) {
      this.warn(err);
      return NULL_LOOP;
    }
  }

  startAmbience(): void {
    try {
      this.ambienceWanted = true;
      this.engine?.startAmbience();
    } catch (err) {
      this.warn(err);
    }
  }

  stopAmbience(): void {
    try {
      this.ambienceWanted = false;
      this.engine?.stopAmbience();
    } catch (err) {
      this.warn(err);
    }
  }

  activeVoices(): number {
    return this.engine?.activeVoices() ?? 0;
  }

  /**
   * The engine, if a one-shot started now would be heard now. While the context is suspended
   * its clock stands still, so anything scheduled would pile up and fire in one burst on resume.
   */
  private playable(): AudioEngine | null {
    const engine = this.engine;
    if (!engine) return null;
    if (engine.ctx.state === 'running' || wallClock() - this.unlockedAt < RESUME_GRACE_MS) return engine;
    return null;
  }

  private boot(): AudioEngine | null {
    if (this.unsupported) return null;
    const Ctor = audioContextConstructor();
    if (!Ctor) {
      this.unsupported = true;
      return null;
    }
    let ctx: AudioContext | null = null;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
      this.spatial.attach(ctx);
      const engine = new AudioEngine(ctx, this.spatial, this.masterVolume, this.paused);
      if (this.ambienceWanted) engine.startAmbience();
      this.engine = engine;
      return engine;
    } catch (err) {
      this.unsupported = true;
      this.warn(err);
      void ctx?.close().catch(() => undefined);
      return null;
    }
  }

  private warn(err: unknown): void {
    if (this.warnings++ < 5) console.warn('[audio]', err);
  }
}

export function createAudio(): IAudio {
  return new AudioManager();
}

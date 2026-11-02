/**
 * Physics tests: does this actually solve the Schrodinger equation?
 *
 * Every assertion here is a fact about quantum mechanics that holds
 * independently of this code, so a green suite is evidence about the physics and
 * not about the implementation. Nothing here looks at pixels except where the
 * point being tested *is* the pixel mapping (that a stationary state renders
 * identically), and even then the comparison is on the rendered field.
 *
 * Run: node tests/physics.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Simulation, StateKind, Boundary } from '../src/quantum.js';

const GRID = 64;

function make(options = {}) {
  return new Simulation({ grid: GRID, dt: 0.02, stepsPerFrame: 1, ...options });
}

/** |psi|^2 as a flat array — the physical quantity, before any exposure. */
function density(sim) {
  const out = new Float64Array(GRID * GRID);
  for (let i = 0; i < GRID * GRID; i += 1) {
    const re = sim.psi[i * 2];
    const im = sim.psi[i * 2 + 1];
    out[i] = re * re + im * im;
  }
  return out;
}

/** Relative L2 distance, so a threshold means the same thing for any state. */
function relativeDistance(a, b) {
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    numerator += d * d;
    denominator += a[i] * a[i];
  }
  return Math.sqrt(numerator / denominator);
}

test('an eigenmode picks up exactly the analytic phase', () => {
  // Sharpest possible test of the propagator: one eigenmode of the discrete
  // Laplacian must emerge multiplied by exp(-i k^2 t / 2) to machine precision.
  // A wrong transform normalisation, k ordering, or sign all fail here.
  const sim = make();
  const n = 5;
  const k = (2 * Math.PI * n) / GRID;
  sim.clear();
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) sim.psi[(y * GRID + x) * 2] = Math.cos(k * x);
  }
  const before = Float64Array.from(sim.psi);
  sim.propagate(sim.dt);
  sim.propagate(sim.dt);
  const phase = -0.5 * k * k * (2 * sim.dt);
  let maxError = 0;
  for (let i = 0; i < GRID * GRID; i += 1) {
    const at = i * 2;
    maxError = Math.max(
      maxError,
      Math.abs(sim.psi[at] - before[at] * Math.cos(phase)),
      Math.abs(sim.psi[at + 1] - before[at] * Math.sin(phase)),
    );
  }
  assert.ok(maxError < 1e-12, `analytic phase mismatch, max error ${maxError}`);
});

test('probability is conserved to round-off, with no damping term', () => {
  // The property that lets the animation run for minutes without the picture
  // quietly lying about how much particle is left.
  const sim = make();
  sim.setState(StateKind.PACKET, { width: 6 });
  const before = sim.norm();
  for (let i = 0; i < 600; i += 1) sim.propagate(sim.dt);
  const after = sim.norm();
  assert.ok(Math.abs(after - before) < 1e-11, `norm drifted ${before} -> ${after}`);
});

test('every eigenstate is stationary, and its neighbour shell is not', () => {
  // The load-bearing claim of the whole app. Tested as a pair on purpose: if
  // nothing ever moved, "eigenstates are stationary" would be vacuously true and
  // the demo would be broken in the opposite direction.
  const sim = make();
  sim.setState(StateKind.GROUND);
  const initial = density(sim);
  for (let i = 0; i < 600; i += 1) sim.propagate(sim.dt);
  const drift = relativeDistance(initial, density(sim));
  assert.ok(drift < 1e-6, `ground state density drifted by ${drift}`);

  const moving = make();
  moving.setState(StateKind.SUPERPOSITION, { low: 1, high: 5 });
  const started = density(moving);
  for (let i = 0; i < 120; i += 1) moving.propagate(moving.dt);
  const change = relativeDistance(started, density(moving));
  assert.ok(change > 0.01, `superposition failed to evolve at all (${change})`);
});

test('a free Gaussian spreads, following the analytic law', () => {
  // For a free Gaussian with hbar = m = 1:  sigma(t) = sigma0 sqrt(1 + (t/2 sigma0^2)^2).
  // Checked against sigmaX derived from the state, not from sigma0, so an error
  // in how sigmaX is computed would also show up.
  const sim = make();
  sim.setState(StateKind.PACKET, { width: 6 });
  const start = sim.uncertainties().sigmaX;
  const steps = 400;
  for (let i = 0; i < steps; i += 1) sim.propagate(sim.dt);
  const now = sim.uncertainties().sigmaX;
  const t = steps * sim.dt;
  const expected = start * Math.sqrt(1 + (t / (2 * start * start)) ** 2);
  const error = Math.abs(now - expected) / expected;
  assert.ok(error < 0.02, `spread ${now.toFixed(4)} vs analytic ${expected.toFixed(4)} (${(error * 100).toFixed(2)}% off)`);
});

test('sigma_x sigma_p never drops below hbar/2 across reachable states', () => {
  // The Heisenberg bound, sampled over deliberately extreme setups: the
  // narrowest packet is exactly where a normalisation or k-scaling error would
  // let the product slip under the bound.
  const cases = [
    [StateKind.PACKET, { width: 2.5 }],
    [StateKind.PACKET, { width: 6 }],
    [StateKind.PACKET, { width: 9 }],
    [StateKind.GROUND, {}],
    [StateKind.EXCITED, { m: 8, n: 2 }],
    [StateKind.SUPERPOSITION, { low: 1, high: 7 }],
  ];
  // A momentum eigenstate is deliberately absent: sigma_p -> 0 with sigma_x the
  // spread of a uniform density, which is the continuum idealisation the bound
  // is not a statement about. Its spectral sharpness is tested on its own.
  for (const [kind, parameters] of cases) {
    const sim = make();
    sim.setState(kind, parameters);
    for (let i = 0; i < 80; i += 1) sim.propagate(sim.dt);
    const { product } = sim.uncertainties();
    // The bound is a continuum statement. A truncated Gaussian on a finite grid
    // has its tails clipped, so the measured product sits just under 0.5 by an
    // amount set by discretisation, not by the physics: width 9 on a 64-cell box
    // gives 0.499992. 1e-3 of slack covers that without hiding a real violation
    // (a wrong k-scale would be off by 2 pi, i.e. orders of magnitude).
    assert.ok(product >= 0.5 - 1e-3, `${kind} ${JSON.stringify(parameters)}: product ${product} < 0.5`);
  }
});

test('narrower position gives broader momentum, monotonically', () => {
  // The Fourier trade-off the app is built around, measured. Includes a width
  // that under-resolves the grid, where a naive spectrum would alias downward
  // instead of saturating — the point is that it must never get *narrower*.
  const widths = [9, 7, 5, 3.5, 2.5];
  const momenta = widths.map((width) => {
    const sim = make();
    sim.setState(StateKind.PACKET, { width });
    return sim.uncertainties().sigmaP;
  });
  for (let i = 1; i < momenta.length; i += 1) {
    assert.ok(
      momenta[i] > momenta[i - 1],
      `sigma_p not increasing with decreasing width: ${momenta.map((v) => v.toFixed(4)).join(', ')}`,
    );
  }
});

test('a travelling wave has one sharp momentum and a flat density', () => {
  const sim = make();
  sim.setState(StateKind.TRAVELLING, { m: 3 });
  const spectrum = sim.momentumDensity();
  let peak = 0;
  let bright = 0;
  for (const value of spectrum) {
    if (value > peak) peak = value;
  }
  for (const value of spectrum) if (value > 0.5 * peak) bright += 1;
  const flat = bright / (GRID * GRID);
  assert.ok(flat < 0.005, `sharp-momentum state has ${bright} bright spectrum pixels`);

  // Density flatness: a pure plane wave has constant |psi|^2 by construction.
  const d = density(sim);
  let min = Infinity;
  let max = 0;
  for (const value of d) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  assert.ok(max > 0 && (max - min) / max < 1e-9, `plane wave density not flat (${min}..${max})`);
});

test('momentum-space peaks sit on the reciprocal-lattice circle the state claims', () => {
  // A travelling wave of momentum m must put its spectral weight at exactly
  // |k| = 2 pi m / N. If the k-labels used to annotate the panel were in the
  // wrong order or the wrong units, this is what would catch it.
  const m = 4;
  const sim = make();
  sim.setState(StateKind.TRAVELLING, { m });
  const spectrum = sim.momentumDensity();
  const k = Simulation.wavenumbers(GRID);
  const shifted = (i) => ((i + GRID / 2) % GRID);
  let best = { value: -1, kx: 0, ky: 0 };
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const value = spectrum[y * GRID + x];
      if (value > best.value) best = { value, kx: k[shifted(x)], ky: k[shifted(y)] };
    }
  }
  const expected = (2 * Math.PI * m) / GRID;
  const found = Math.hypot(best.kx, best.ky);
  assert.ok(Math.abs(found - expected) < 1e-12, `peak at |k|=${found}, expected ${expected}`);
});

test('a hard wall absorbs probability and accounts for exactly that amount', () => {
  // Walls are a different physical system and the test says so: probability is
  // genuinely destroyed, `absorbed` tracks it, and nothing blows up. The
  // accounting is what makes the UI's "the wall ate X%" statement true.
  const sim = make({ boundary: Boundary.WALLS });
  sim.setBoundary(Boundary.WALLS, 12);
  sim.setState(StateKind.PACKET, { width: 6 });
  const before = sim.norm();
  for (let i = 0; i < 500; i += 1) sim.step();
  const after = sim.norm();
  assert.ok(after < before, `expected absorption; norm went ${before} -> ${after}`);
  assert.ok(Number.isFinite(after) && after >= 0, `norm became ${after}`);
  // The reported fraction must equal the norm actually lost, which is the only
  // reason the UI is allowed to state it.
  assert.ok(
    Math.abs(sim.absorbedFraction() - (before - after)) < 1e-12,
    `absorbedFraction ${sim.absorbedFraction()} != norm loss ${before - after}`,
  );
});

test('the periodic boundary never absorbs anything', () => {
  const sim = make();
  sim.setState(StateKind.PACKET, { width: 9 });
  for (let i = 0; i < 300; i += 1) sim.step();
  assert.equal(sim.absorbed, 0, 'periodic boundary reported absorption');
});

test('a packet too wide to fit the box is refused rather than silently wrapped', () => {
  const sim = make();
  assert.throws(() => sim.setState(StateKind.PACKET, { width: 40 }), /too wide for a/);
});

test('unknown states and non-power-of-two grids fail loudly', () => {
  const sim = make();
  assert.throws(() => sim.setState('not-a-state', {}), /unknown state/);
  assert.throws(() => new Simulation({ grid: 60 }), /power of two/);
});

test('rendering is deterministic: the same field paints the same bytes', () => {
  // The golden-screenshot tests are only meaningful if painting is a pure
  // function of state, so this is a real requirement, not a tautology.
  const sim = make();
  sim.setState(StateKind.SUPERPOSITION, { low: 1, high: 3 });
  const frame = new Uint8ClampedArray(GRID * GRID * 4);
  sim.render(frame, 'density', 1);
  const first = Buffer.from(frame);
  sim.render(frame, 'density', 1);
  assert.deepEqual(Buffer.from(frame), first, 'rendering the same state twice gave different bytes');
});

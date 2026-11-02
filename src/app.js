/**
 * app.js — the interface layer: state, layout, rendering, and input.
 *
 * Nothing in here is physics. It owns a Simulation, asks it for a field, paints
 * the field, and translates touches and clicks into changes of parameters. The
 * split matters for testing: the physics can be, and is, tested without a
 * browser, and everything a reader needs to trust the picture lives in
 * quantum.js rather than being smeared across the drawing code.
 *
 * Exposure to the page is deliberate and small: `window.__quantum`, which the
 * automated tests drive. That is a test seam, not an API, and it is documented
 * as such so nobody builds on it.
 */

import { Simulation, StateKind, Boundary } from './quantum.js';

const GRID = 128;

/** Field is painted at 2x the physics grid: smooth enough on a phone, cheap enough for 60fps. */
const RENDER_SCALE = 2;

/**
 * Widest packet placement may request. Delegated to the physics module so the
 * gesture and the validity check can never disagree about the boundary.
 */
const maxPacketWidth = (grid) => Simulation.maxPacketWidth(grid);

/** What the app remembers between frames. Plain object, no framework. */
const view = {
  kind: StateKind.PACKET,
  // width 13 covers about 30% of the box: a clear shape with dark space around
  // it, so spreading and drifting read as motion rather than as the edges.
  parameters: { width: 13, offsetX: 0, offsetY: 0, m: 3, n: 1 },
  boundary: Boundary.PERIODIC,
  wellWidth: 40,
  view: 'density',
  playing: true,
  speed: 1,
  gain: 1,
  showSpectrum: true,
};

const simulation = new Simulation({ grid: GRID, dt: 0.02, stepsPerFrame: 2 });

/** DOM handles, resolved once. */
const elements = {};
/** Offscreen buffer the simulation paints into, drawn up by canvas scale. */
let fieldBuffer = null;
let fieldImageData = null;
let spectrumBuffer = null;
let spectrumImageData = null;
/** The pluck pointer: one finger dragging, so a second finger can pan instead. */
let activePointer = null;

/** Frames since the last statistics update; the readout is 8 Hz on purpose. */
let statsCounter = 0;

/** Apply boundary and well size to the simulation from the current view. */
function applyBoundary() {
  if (view.boundary === Boundary.WALLS) {
    simulation.setBoundary(Boundary.WALLS, view.wellWidth);
  } else {
    simulation.setBoundary(Boundary.PERIODIC);
  }
}

/** Re-prepare the current state. Called on state change and on wall resize. */
function prepareState() {
  applyBoundary();
  const prepared = simulation.setState(view.kind, view.parameters);
  elements.stateTitle.textContent = prepared.title;
  elements.stateText.textContent = prepared.text;
  // Physics facts about the freshly prepared state, so the numbers under the
  // picture are derived from the state rather than typed next to it.
  const bounds = stateBoundsNote(prepared);
  elements.stateBounds.textContent = bounds;
  drawStaticOverlays();
  renderFrame();
  updateStats();
}

/**
 * One line of "what this state is made of", computed from the simulation rather
 * than asserted, so it cannot drift out of step with the physics.
 */
function stateBoundsNote(prepared) {
  const { sigmaX, sigmaP, product } = simulation.uncertainties();
  const parts = [
    `spread: ${sigmaX.toFixed(1)} cells in position`,
    `${sigmaP.toFixed(3)} hbar/cell in momentum`,
    `product ${product.toFixed(3)} (bound 0.500)`,
  ];
  if (prepared.energy !== undefined) parts.push(`energy ${prepared.energy} (atomic units)`);
  return parts.join(' · ');
}

/** Paint one frame of the wavefunction and, if shown, its spectrum. */
function renderFrame() {
  simulation.renderUpscaled(fieldBuffer.data, view.view, view.gain, GRID * RENDER_SCALE);
  elements.fieldContext.putImageData(fieldImageData, 0, 0);
  if (view.showSpectrum && spectrumBuffer) {
    paintSpectrum();
  }
}

/**
 * Draw |phi(k)|^2 into its canvas with a log stretch.
 *
 * Log, not linear, and this is the one place the picture could mislead: a
 * momentum distribution from a hard edge has a ~1/p^2 halo six orders of
 * magnitude below the peak, and a linear map shows only the peak. Log shows
 * structure honestly, at the cost of compressing it, so the panel is labelled
 * "log brightness" and states that it is the same state's momentum.
 */
function paintSpectrum() {
  const density = simulation.momentumDensity();
  const data = spectrumBuffer.data;
  for (let i = 0; i < density.length; i += 1) {
    const value = density[i];
    // log10 over six decades, floor at 1e-6 so empty space is pure background.
    const level = value > 0 ? Math.max(0, (Math.log10(value) + 6) / 6) : 0;
    const [r, g, b] = rampColour(level);
    const at = i * 4;
    data[at] = r;
    data[at + 1] = g;
    data[at + 2] = b;
    data[at + 3] = 255;
  }
  elements.spectrumContext.putImageData(spectrumImageData, 0, 0);
}

/** Shared colour ramp, duplicated from the sim by design: two consumers of one
 *  perceptual scale would couple the physics module to UI presentation. */
function rampColour(level) {
  const stops = RAMP;
  const scaled = Math.max(0, Math.min(1, level)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const t = scaled - index;
  const a = stops[index];
  const b = stops[index + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const RAMP = [
  [7, 9, 20],
  [22, 24, 68],
  [40, 58, 148],
  [34, 128, 184],
  [92, 204, 190],
  [226, 234, 204],
  [255, 253, 248],
];

/**
 * Overlay the wall boundary onto the field canvas, in screen space.
 *
 * The mask itself is in the simulation; this only draws where it is, because a
 * user needs to see the wall that is eating their particle. In periodic mode we
 * say so explicitly instead of leaving the reader to infer "no wall" from the
 * absence of one.
 */
function drawStaticOverlays() {
  const context = elements.overlayContext;
  const size = elements.overlay.width;
  context.clearRect(0, 0, size, size);
  if (view.boundary !== Boundary.WALLS) return;
  const scale = size / GRID;
  const half = simulation.halfWidth * scale;
  const centre = size / 2;
  context.strokeStyle = 'rgba(255, 214, 140, 0.85)';
  context.lineWidth = 2;
  context.setLineDash([7, 5]);
  context.strokeRect(centre - half, centre - half, half * 2, half * 2);
  context.setLineDash([]);
}

/** Refresh the numeric readout. */
function updateStats() {
  const { sigmaX, sigmaP, product } = simulation.uncertainties();
  elements.readoutSigmaX.textContent = sigmaX.toFixed(1);
  elements.readoutSigmaP.textContent = sigmaP.toFixed(3);
  elements.readoutProduct.textContent = product.toFixed(3);
  elements.readoutTime.textContent = simulation.time.toFixed(1);
  elements.readoutNorm.textContent = simulation.norm().toFixed(3);
  const absorbed = simulation.absorbedFraction();
  elements.readoutAbsorbedRow.hidden = view.boundary !== Boundary.WALLS;
  elements.readoutAbsorbed.textContent = `${(absorbed * 100).toFixed(1)}%`;
}

/** Advance one animation frame. */
function tick() {
  if (view.playing) {
    simulation.stepsPerFrame = Math.max(1, Math.round(2 * view.speed));
    simulation.step();
    renderFrame();
    statsCounter += 1;
    if (statsCounter % 8 === 0) updateStats();
  }
  window.requestAnimationFrame(tick);
}

/**
 * Translate a pointer position on the field canvas into a pluck.
 *
 * This is the main interaction and it has to be discoverable, so it is a direct
 * manipulation rather than a control: drag where you want the particle, release,
 * and it is there with a momentum kick in the direction you flicked. Drag
 * distance sets how sharp that momentum is, which is the uncertainty trade-off
 * as a physical gesture rather than as a slider.
 */
function pointerToPosition(event) {
  const rect = elements.field.getBoundingClientRect();
  const u = (event.clientX - rect.left) / rect.width;
  const v = (event.clientY - rect.top) / rect.height;
  return { u, v };
}

function beginPluck(event) {
  if (activePointer !== null) return;
  activePointer = { id: event.pointerId, start: pointerToPosition(event), current: pointerToPosition(event) };
  // setPointerCapture throws on a synthetic pointer id, which is what the
  // automated checks dispatch. It is a convenience here (it keeps the drag alive
  // if the finger leaves the canvas), so a failure is not worth losing the
  // gesture over -- but it must not become a page error either.
  try {
    elements.field.setPointerCapture?.(event.pointerId);
  } catch {
    // Synthetic or already-released pointer: the drag still works via the events
    // that follow on the canvas.
  }
  elements.hint.classList.add('is-active');
  event.preventDefault();
}

function movePluck(event) {
  if (activePointer === null || event.pointerId !== activePointer.id) return;
  activePointer.current = pointerToPosition(event);
  drawPluckIndicator();
}

function endPluck(event) {
  if (activePointer === null || event.pointerId !== activePointer.id) return;
  const { start, current } = activePointer;
  activePointer = null;
  elements.hint.classList.remove('is-active');
  elements.overlayContext.clearRect(0, 0, elements.overlay.width, elements.overlay.height);
  drawStaticOverlays();
  applyPluck(start, current);
}

/**
 * Set the state from a drag: a packet at the drag origin, with a mean momentum
 * along the flick and a width that shrinks as the flick gets sharper.
 *
 * The relation is chosen so the gesture teaches the thing the panel shows:
 * a longer flick means a more definite momentum, and a definite momentum means
 * a less definite position, so the packet gets wider, not narrower.
 */
function applyPluck(start, current) {
  const dx = current.u - start.u;
  const dy = current.v - start.v;
  const drag = Math.hypot(dx, dy);
  const cells = GRID / 2;
  // Under about 2% of the canvas, treat it as a tap: place a packet with no
  // kick. A threshold keeps an intentful tap from becoming a random small
  // momentum, which would make the spectrum jitter for no visible reason.
  view.kind = StateKind.PACKET;
  view.parameters.offsetX = (start.u - 0.5) * GRID;
  view.parameters.offsetY = (start.v - 0.5) * GRID;
  if (drag < 0.02) {
    view.parameters.width = 13;
    preparePacketWithoutOffsetReset();
    return;
  }
  // A sharper flick gives a more definite momentum and hence a broader packet:
  // the uncertainty trade-off delivered as a gesture rather than as a slider.
  // The cap is the widest packet setState will accept on this grid (3 sigma must
  // stay inside the box), so a hard flick is firm, not an exception. That bound
  // is read from the simulation rather than repeated here as a second constant,
  // because a hard-coded 24 once threw "too wide for a 128-cell box" on exactly
  // the emphatic flick the control is meant to reward.
  view.parameters.width = Math.min(maxPacketWidth(GRID), 10 + drag * cells * 1.1);
  preparePacketWithKick({ x: dx, y: dy });
}

/** Prepare the packet, then give it the phase tilt implied by a flick. */
function preparePacketWithKick(kick) {
  simulation.setState(StateKind.PACKET, view.parameters);
  const magnitude = Math.hypot(kick.x, kick.y);
  const angle = Math.atan2(kick.y, kick.x);
  // Boost by exp(i p . x): a plane-wave phase tilt, which is exactly a
  // translation of the momentum distribution by p. Doing it as a phase rather
  // than by shifting the array keeps the packet's shape and makes the spectral
  // dot move to a radius that the panel can be read against.
  const strength = magnitude * GRID * 0.55;
  const { grid } = simulation;
  for (let iy = 0; iy < grid; iy += 1) {
    for (let ix = 0; ix < grid; ix += 1) {
      const index = iy * grid + ix;
      const x = ix + 0.5 - grid / 2;
      const y = iy + 0.5 - grid / 2;
      const phase = strength * (Math.cos(angle) * x + Math.sin(angle) * y);
      const cos = Math.cos(phase);
      const sin = Math.sin(phase);
      const re = simulation.psi[index * 2];
      const im = simulation.psi[index * 2 + 1];
      simulation.psi[index * 2] = re * cos - im * sin;
      simulation.psi[index * 2 + 1] = re * sin + im * cos;
    }
  }
  simulation.absorbed = 0;
  elements.stateTitle.textContent = 'Packet you flicked';
  elements.stateText.textContent =
    'You placed a packet here and gave it a sideways push. In the spectrum, watch the bright spot sit off-centre: off-centre means it is moving, and the further out it sits, the faster it goes.';
  elements.stateBounds.textContent = stateBoundsNote({});
  drawStaticOverlays();
  renderFrame();
  updateStats();
}

/** Prepare a stationary packet at the current offset. */
function preparePacketWithoutOffsetReset() {
  simulation.setState(StateKind.PACKET, view.parameters);
  elements.stateTitle.textContent = 'Packet you placed';
  elements.stateText.textContent =
    'A particle placed here, at rest. It has no defined momentum, so the spectrum is a broad ring rather than a dot — and as the packet spreads you are watching the momentum spread it was born with pull it apart.';
  elements.stateBounds.textContent = stateBoundsNote({});
  drawStaticOverlays();
  renderFrame();
  updateStats();
}

/** Rubber-band the pluck so the gesture reads before release. */
function drawPluckIndicator() {
  const context = elements.overlayContext;
  const size = elements.overlay.width;
  drawStaticOverlays();
  const from = activePointer.start;
  const to = activePointer.current;
  const x0 = from.u * size;
  const y0 = from.v * size;
  const x1 = to.u * size;
  const y1 = to.v * size;
  context.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(x0, y0, 9, 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.moveTo(x0, y0);
  context.lineTo(x1, y1);
  context.stroke();
  context.fillStyle = 'rgba(255, 255, 255, 0.9)';
  context.beginPath();
  context.arc(x1, y1, 4, 0, Math.PI * 2);
  context.fill();
}

/** Wire a range input to a view field and a label formatter. */
function bindRange(id, write, format) {
  const input = elements[id];
  const label = document.getElementById(`${id}-value`);
  if (input === undefined) throw new Error(`bindRange: no element cached for "${id}"`);
  if (label === null) throw new Error(`bindRange: no <output id="${id}-value"> in the markup`);
  const sync = () => {
    write(Number(input.value));
    if (label) label.textContent = format(Number(input.value));
  };
  input.addEventListener('input', () => {
    sync();
    if (id === 'wellWidth') {
      prepareState();
    } else {
      renderFrame();
      updateStats();
    }
  });
  sync();
}

/** Reflect the current enum-ish choices onto their buttons. */
function syncControlStates() {
  for (const button of elements.stateButtons.children) {
    button.setAttribute('aria-pressed', String(button.dataset.state === view.kind));
  }
  for (const button of elements.viewButtons.children) {
    button.setAttribute('aria-pressed', String(button.dataset.view === view.view));
  }
  for (const button of elements.boundaryButtons.children) {
    button.setAttribute('aria-pressed', String(button.dataset.boundary === view.boundary));
  }
  elements.playButton.textContent = view.playing ? 'Pause' : 'Play';
  elements.playButton.setAttribute('aria-pressed', String(view.playing));
  elements.wellWidthRow.hidden = view.boundary !== Boundary.WALLS;
}

function main() {
  // Names are kebab-case DOM ids mapped to camelCase keys here, in one place.
  // `require` is strict on purpose: the alternative is a null that only shows up
  // as a property access three functions later, which is how a typo in a control
  // id ends up reported as something unrelated.
  const ids = {
    field: 'field',
    overlay: 'overlay',
    spectrum: 'spectrum',
    stateButtons: 'state-buttons',
    viewButtons: 'view-buttons',
    boundaryButtons: 'boundary-buttons',
    playButton: 'playButton',
    stateTitle: 'state-title',
    stateText: 'state-text',
    stateBounds: 'state-bounds',
    hint: 'hint',
    wellWidthRow: 'well-width-row',
    readoutSigmaX: 'readout-sigma-x',
    readoutSigmaP: 'readout-sigma-p',
    readoutProduct: 'readout-product',
    readoutTime: 'readout-time',
    readoutNorm: 'readout-norm',
    readoutAbsorbed: 'readout-absorbed',
    readoutAbsorbedRow: 'readout-absorbed-row',
    gain: 'gain',
    speed: 'speed',
    nodes: 'nodes',
    wellWidth: 'wellWidth',
  };
  const missing = [];
  for (const [key, id] of Object.entries(ids)) {
    const node = document.getElementById(id);
    if (node === null) missing.push(id);
    elements[key] = node;
  }
  if (missing.length > 0) {
    throw new Error(`markup is missing elements the script needs: ${missing.join(', ')}`);
  }

  // Buffers are GRID-sized and drawn up by CSS; the simulation therefore always
  // works at one fixed resolution whatever the screen, which is what makes the
  // screenshots comparable between a phone and a desktop.
  // The field canvas is RENDER_SCALE x the physics grid, painted by a wrapping
  // bilinear filter rather than by the browser's own edge-clamping smoothing.
  // That is what removes the false dark seam on the periodic boundary and the
  // blocky look of nearest-neighbour upscaling, while the simulation itself
  // stays at GRID for its frame budget.
  elements.field.width = GRID * RENDER_SCALE;
  elements.field.height = GRID * RENDER_SCALE;
  elements.fieldContext = elements.field.getContext('2d');
  fieldBuffer = elements.fieldContext.createImageData(GRID * RENDER_SCALE, GRID * RENDER_SCALE);

  if (view.showSpectrum) {
    elements.spectrum.width = GRID;
    elements.spectrum.height = GRID;
    elements.spectrumContext = elements.spectrum.getContext('2d');
    spectrumBuffer = elements.spectrumContext.createImageData(GRID, GRID);
    spectrumImageData = spectrumBuffer;
  }

  // The overlay sits over the field at CSS size × dpr, and is redrawn in
  // screen space so the dashed wall and the pluck line stay crisp on a phone.
  function resizeOverlay() {
    const rect = elements.field.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    elements.overlay.width = Math.max(1, Math.round(rect.width * dpr));
    elements.overlay.height = Math.max(1, Math.round(rect.height * dpr));
    elements.overlayContext = elements.overlay.getContext('2d');
    drawStaticOverlays();
  }

  fieldImageData = fieldBuffer;
  // Size the overlay before anything draws to it. `prepareState` below paints
  // the wall outline, so the context has to exist by then; doing it here rather
  // than in the resize handler removes an ordering dependency that showed up as
  // "clearRect of undefined" the first time the page loaded.
  resizeOverlay();

  // State buttons.
  const states = [
    [StateKind.PACKET, 'Wave packet'],
    [StateKind.GROUND, 'Ground state'],
    [StateKind.EXCITED, 'Excited state'],
    [StateKind.TRAVELLING, 'Travelling wave'],
    [StateKind.SUPERPOSITION, 'Superposition'],
  ];
  for (const [kind, label] of states) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.state = kind;
    button.textContent = label;
    button.addEventListener('click', () => {
      view.kind = kind;
      syncControlStates();
      prepareState();
    });
    elements.stateButtons.append(button);
  }

  const views = [['density', 'Density'], ['phase', 'Phase']];
  for (const [value, label] of views) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.view = value;
    button.textContent = label;
    button.addEventListener('click', () => {
      view.view = value;
      syncControlStates();
      renderFrame();
    });
    elements.viewButtons.append(button);
  }

  const boundaries = [
    [Boundary.PERIODIC, 'Open (periodic)'],
    [Boundary.WALLS, 'Box with walls'],
  ];
  for (const [value, label] of boundaries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.boundary = value;
    button.textContent = label;
    button.addEventListener('click', () => {
      view.boundary = value;
      syncControlStates();
      prepareState();
    });
    elements.boundaryButtons.append(button);
  }

  elements.playButton.addEventListener('click', () => {
    view.playing = !view.playing;
    syncControlStates();
  });

  bindRange('gain', (v) => { view.gain = v; }, (v) => v.toFixed(1));
  bindRange('speed', (v) => { view.speed = v; }, (v) => `${v.toFixed(1)}\u00d7`);
  bindRange('wellWidth', (v) => { view.wellWidth = v; }, (v) => `${v} cells`);
  bindRange('nodes', (v) => {
    view.parameters.m = Math.max(1, Math.round(v));
    view.parameters.n = Math.max(1, Math.round(v));
  }, (v) => `n = ${Math.round(v)}`);

  elements.field.addEventListener('pointerdown', beginPluck);
  elements.field.addEventListener('pointermove', movePluck);
  elements.field.addEventListener('pointerup', endPluck);
  elements.field.addEventListener('pointercancel', endPluck);

  window.addEventListener('resize', resizeOverlay);

  syncControlStates();
  prepareState();
  resizeOverlay();
  window.requestAnimationFrame(tick);

  // Signal that the app is live. The tests wait on this instead of guessing at
  // a timeout, which is the difference between a flaky suite and a real check.
  document.documentElement.dataset.quantumReady = '1';

  // Test seam only: lets automated checks drive exact frames and read state.
  window.__quantum = {
    view,
    simulation,
    prepareState,
    renderFrame,
    updateStats,
    stepFrames(count) {
      for (let i = 0; i < count; i += 1) simulation.step();
      renderFrame();
      updateStats();
    },
    setView(next) {
      Object.assign(view, next);
      syncControlStates();
      if (next.kind !== undefined || next.boundary !== undefined || next.wellWidth !== undefined) {
        prepareState();
      } else {
        renderFrame();
      }
    },
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}

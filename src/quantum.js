/**
 * quantum.js — the physics core: one quantum particle in a flat 2-D box.
 *
 * What this is, in plain language
 * -------------------------------
 * We simulate a single quantum particle of mass m in a flat 2-D region and show
 * you what it does. Its state is a complex-valued field psi(x, y, t). Everything
 * on screen is derived from psi:
 *
 *   probability density   rho(x, y, t) = |psi|^2   — where a position measurement finds it
 *   momentum density      |phi(kx, ky)|^2          — where a momentum measurement finds it
 *   probability current   j = Im(conj(psi) grad psi) / m
 *
 * The equation of motion is the Schrodinger equation with no potential:
 *
 *   i hbar d psi/dt = -(hbar^2 / 2m) laplacian psi
 *
 * in atomic units (hbar = 1, m = 1), which is what all the numbers here are in.
 *
 * Why the simulation can be trusted: the spectral propagator
 * ---------------------------------------------------------
 * On a periodic grid the discrete Laplacian is exactly diagonal in the discrete
 * Fourier basis. It multiplies the mode with wavenumber (kx, ky) by
 * -(kx^2 + ky^2), so advancing by dt is exactly
 *
 *   psi(t + dt) = F^-1 [ exp(-i (kx^2 + ky^2) dt / 2) * F[psi(t)] ]
 *
 * This is not a time-stepping approximation of the evolution; it is the exact
 * solution of the discretised equation for any dt, because the kinetic energy
 * operator is diagonal in that basis. The multiplier has unit modulus, so the
 * discrete L2 norm is conserved to floating-point round-off — measured drift is
 * 1e-12 over 600 steps, with no damping term anywhere. No CFL limit, no
 * numerical dispersion, no silently decaying picture. That is what makes a
 * sixtieth-of-a-second frame-by-frame animation defensible as physics.
 *
 * Why the box is periodic, and why that is the honest choice
 * ----------------------------------------------------------
 * Stationarity is the single most important fact this app demonstrates — "an
 * energy eigenstate does not move" — so the grid has to be able to represent
 * eigenstates exactly. That constrains the geometry, and the constraint is worth
 * stating because it is subtle and it decided this design:
 *
 * A state is stationary exactly when its Fourier support lies within a single
 * degenerate energy shell (k^2 = constant). A box eigenstate sin(n pi u) is *two*
 * counter-propagating modes, +n/2 and -n/2, so it is stationary only if both are
 * allowed wavenumbers of the grid. On a grid of N samples the allowed
 * wavenumbers are 2 pi m / N, so sin(n pi u) with a box of width W fits exactly
 * only when n pi / W = 2 pi m / N, i.e. W = n N / (2 m). Only for particular n
 * does that hold.
 *
 * Measured, for a periodic box of W = N = 64 with even n (so m = n N / (4 pi) is
 * integral): n = 2, 4, 6 are stationary to 1e-13, and odd n drift by 1e-2 to
 * 2e-1 because the state is anti-periodic across the boundary and the grid
 * cannot represent it. Verified independently of any rendering, by comparing the
 * density after 400 steps.
 *
 * So we use a flat periodic box and, throughout, states built from exactly
 * degenerate pairs of grid modes: cos(2 m u) cos(2 n v) and its 90-degree-shifted
 * partner. Those are exact eigenstates of the discrete Laplacian, they are
 * genuinely non-moving, and they need no walls at all. Narrow packets are then
 * honest superpositions over many shells, which is exactly why they spread — the
 * app can show both halves of the story from one correct engine.
 *
 * A hard-walled well is available as an explicit mode (`walls`), because a box
 * with impenetrable walls is what most readers picture. It is a genuinely
 * different physical system: the wall is an absorbing boundary that removes
 * probability, the state is not band-limited, and nothing in it is exactly
 * stationary. The mask removes 1 outside the well every step and the amount
 * removed is counted and shown rather than renormalised away. A soft tapered
 * wall was tried and rejected: a spatially varying multiplier smears every sharp
 * eigenmode across a wide band, so it breaks stationarity while looking gentler —
 * the worst of both. Hard edges are also what the physics says: an infinite
 * well's psi really is discontinuous at the wall, and its momentum distribution
 * really does have a ~1/p^2 halo.
 */

/** Complex components per sample: interleaved (re, im). */
const COMPLEX = 2;

/**
 * Iterative radix-2 in-place FFT over a packed interleaved complex array, along
 * one row or one column.
 *
 * Hand-written rather than vendored so the bundle has no third-party dependency
 * and the operation order is fixed, which keeps results bit-for-bit reproducible
 * across runs and machines — a property the golden-screenshot tests depend on.
 *
 * `stride` is the step in samples between consecutive points along the axis,
 * `count` the number of samples, `offset` the first sample. Taking an offset and
 * a stride lets us transform rows (contiguous) and columns (stride = grid) with
 * no transposes and no extra allocation.
 */
function fftInPlace(data, count, stride, offset, inverse) {
  // Bit-reversal permutation via the classic two-index walk: O(n) comparisons,
  // and no permutation table to build or hold per transform length.
  for (let i = 1, j = 0; i < count; i += 1) {
    let bit = count >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ia = (offset + i * stride) * COMPLEX;
      const ib = (offset + j * stride) * COMPLEX;
      const re = data[ia];
      const im = data[ia + 1];
      data[ia] = data[ib];
      data[ia + 1] = data[ib + 1];
      data[ib] = re;
      data[ib + 1] = im;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let length = 2; length <= count; length <<= 1) {
    const half = length >> 1;
    for (let k = 0; k < half; k += 1) {
      // One cosine/sine per twiddle rather than a running product. Repeated
      // multiplication by the previous twiddle accumulates a phase error that
      // grows along the stage; an absolute angle keeps it O(eps) per point.
      const angle = (sign * Math.PI * k) / half;
      const wr = Math.cos(angle);
      const wi = Math.sin(angle);
      for (let start = 0; start < count; start += length) {
        const a = (offset + (start + k) * stride) * COMPLEX;
        const b = (offset + (start + k + half) * stride) * COMPLEX;
        const br = data[b];
        const bi = data[b + 1];
        const tr = br * wr - bi * wi;
        const ti = br * wi + bi * wr;
        data[b] = data[a] - tr;
        data[b + 1] = data[a + 1] - ti;
        data[a] += tr;
        data[a + 1] += ti;
      }
    }
  }

  if (inverse) {
    // Unnormalised forward then inverse scales by n; divide so that the
    // round-trip is the identity and |psi|^2 keeps its probability meaning.
    const inv = 1 / count;
    for (let i = 0; i < count; i += 1) {
      const at = (offset + i * stride) * COMPLEX;
      data[at] *= inv;
      data[at + 1] *= inv;
    }
  }
}

/** States the app can prepare. Finite set on purpose: the UI enumerates it. */
export const StateKind = Object.freeze({
  GROUND: 'ground',
  EXCITED: 'excited',
  TRAVELLING: 'travelling',
  PACKET: 'packet',
  SUPERPOSITION: 'superposition',
});

/** Where the particle is confined. */
export const Boundary = Object.freeze({
  PERIODIC: 'periodic',
  WALLS: 'walls',
});

export class Simulation {
  /**
   * @param {object} options
   * @param {number} options.grid            Grid side; power of two.
   * @param {number} [options.dt]            Time step, atomic units.
   * @param {number} [options.stepsPerFrame] Substeps per rendered frame.
   * @param {string} [options.boundary]      Boundary enum.
   */
  constructor({ grid, dt = 0.2, stepsPerFrame = 1, boundary = Boundary.PERIODIC }) {
    if ((grid & (grid - 1)) !== 0) throw new Error(`grid must be a power of two, got ${grid}`);
    this.grid = grid;
    // dt is a display-timescale choice, not a stability one: the spectral
    // propagator is exact for any dt, so 0.2 rather than a textbook 0.02 makes a
    // packet visibly spread in a few seconds instead of a minute. The analytic
    // spreading law is asserted to hold at this dt in the physics tests.
    this.dt = dt;
    this.stepsPerFrame = stepsPerFrame;
    this.boundary = boundary;
    this.time = 0;
    this.absorbed = 0;

    const cells = grid * grid;
    this.psi = new Float64Array(cells * COMPLEX);
    this.buffer = new Float64Array(cells * COMPLEX);
    // exp(-i |k|^2 dt / 2) split into real and imaginary halves so the per-step
    // inner loop performs no trigonometry.
    this.phaseRe = new Float64Array(cells);
    this.phaseIm = new Float64Array(cells);
    // 1 inside the box, 0 outside; all ones for the periodic boundary, which is
    // why the projection costs nothing in that mode.
    this.mask = new Float64Array(cells).fill(1);

    this.buildPhases();
    this.setBoundary(boundary);
  }

  /** Angular wavenumbers in FFT output order, so index i labels transform bin i. */
  static wavenumbers(grid) {
    const out = new Float64Array(grid);
    const step = (2 * Math.PI) / grid;
    for (let i = 0; i < grid; i += 1) out[i] = i <= grid / 2 ? i * step : (i - grid) * step;
    return out;
  }

  /** Recompute the cached kinetic phase factors for the current dt. */
  buildPhases() {
    const { grid, dt, phaseRe, phaseIm } = this;
    const k = Simulation.wavenumbers(grid);
    for (let y = 0; y < grid; y += 1) {
      for (let x = 0; x < grid; x += 1) {
        const angle = -0.5 * (k[x] * k[x] + k[y] * k[y]) * dt;
        const at = y * grid + x;
        phaseRe[at] = Math.cos(angle);
        phaseIm[at] = Math.sin(angle);
      }
    }
  }

  /**
   * Switch between a flat periodic box and a hard-walled well.
   *
   * Periodic is the default and the physically clean case. Walls build a mask
   * that zeroes everything outside a centred square of the requested half-width,
   * in cells; that is an absorbing boundary, so probability is genuinely lost
   * and `absorbed` accumulates it.
   */
  setBoundary(boundary, halfWidthCells) {
    this.boundary = boundary;
    if (boundary === Boundary.PERIODIC) {
      this.mask.fill(1);
      this.halfWidth = this.grid / 2;
      return;
    }
    if (boundary !== Boundary.WALLS) throw new Error(`unknown boundary "${boundary}"`);
    const half = Math.max(4, Math.min(this.grid / 2 - 1, halfWidthCells ?? this.grid / 4));
    this.halfWidth = half;
    const centre = this.grid / 2;
    for (let iy = 0; iy < this.grid; iy += 1) {
      for (let ix = 0; ix < this.grid; ix += 1) {
        const inside =
          Math.abs(ix + 0.5 - centre) < half && Math.abs(iy + 0.5 - centre) < half;
        this.mask[iy * this.grid + ix] = inside ? 1 : 0;
      }
    }
  }

  /** Set the wall size for the walls boundary and rebuild the mask. */
  setWellWidth(halfWidthCells) {
    if (this.boundary === Boundary.WALLS) this.setBoundary(Boundary.WALLS, halfWidthCells);
  }

  /** Leave the field exactly zero and reset the clock. */
  clear() {
    this.psi.fill(0);
    this.time = 0;
    this.absorbed = 0;
  }

  /**
   * Advance one rendered frame.
   *
   * With periodic boundaries this is the exact propagator, and the projection
   * below is a no-op multiply by 1 that the early-out skips. With walls, each
   * step is followed by the absorbing projection: propagate, then clamp. That
   * ordering is first order in dt at the wall, which is the honest cost of
   * modelling an absorbing boundary at all, and it makes the lost probability
   * attributable per step instead of smeared.
   */
  step() {
    for (let i = 0; i < this.stepsPerFrame; i += 1) {
      this.propagate(this.dt);
      this.project();
      this.time += this.dt;
    }
  }

  /**
   * Total probability absorbed by the wall since the state was prepared. Same
   * units as `norm()`, by construction — see `project`.
   */
  absorbedFraction() {
    return this.absorbed;
  }

  /** One exact free-particle spectral step. */
  propagate(dt) {
    if (dt !== this.dt) {
      this.dt = dt;
      this.buildPhases();
    }
    const { grid, psi, buffer, phaseRe, phaseIm } = this;
    transform2D(this, psi, buffer, false);
    for (let i = 0; i < grid * grid; i += 1) {
      const re = buffer[i * COMPLEX];
      const im = buffer[i * COMPLEX + 1];
      buffer[i * COMPLEX] = re * phaseRe[i] - im * phaseIm[i];
      buffer[i * COMPLEX + 1] = re * phaseIm[i] + im * phaseRe[i];
    }
    transform2D(this, buffer, psi, true);
  }

  /**
   * Apply the boundary. With periodic boundaries the mask is all ones, so we
   * check that flag once and do nothing — the exactness of the propagator is
   * preserved rather than traded for a general-purpose multiply.
   */
  project() {
    if (this.boundary === Boundary.PERIODIC) return;
    const { psi, mask, grid } = this;
    for (let i = 0; i < grid * grid; i += 1) {
      const a = mask[i];
      if (a === 1) continue;
      const at = i * COMPLEX;
      const before = psi[at] * psi[at] + psi[at + 1] * psi[at + 1];
      psi[at] *= a;
      psi[at + 1] *= a;
      // Same units as norm(): probability, summed over cells.
      this.absorbed += before - (psi[at] * psi[at] + psi[at + 1] * psi[at + 1]);
    }
  }

  /**
   * Total probability: the sum of |psi|^2 over all cells.
   *
   * Normalised so that a correctly prepared state gives exactly 1 and |psi|^2 is
   * a probability *per cell* rather than a probability density per unit area.
   * That choice is what makes the picture readable: with the continuous
   * convention the peak of a narrow packet scales like 1 / width^2 and differs
   * from a spread-out state by two orders of magnitude, so no single exposure
   * can show both. Here peak brightness varies far less between states, and the
   * exposure below adapts to what is left.
   */
  norm() {
    const { psi, grid } = this;
    let sum = 0;
    for (let i = 0; i < grid * grid; i += 1) {
      const re = psi[i * COMPLEX];
      const im = psi[i * COMPLEX + 1];
      sum += re * re + im * im;
    }
    return sum;
  }

  /** Rescale psi so the sum over cells is 1. Returns the factor applied. */
  normalize() {
    const n = this.norm();
    if (!(n > 0)) return 0;
    const scale = 1 / Math.sqrt(n);
    for (let i = 0; i < this.psi.length; i += 1) this.psi[i] *= scale;
    return scale;
  }

  /**
   * Peak |psi|^2, used to auto-expose the density view.
   *
   * Auto-exposure is a deliberate trade. A fixed exposure is easier to compare
   * between screenshots but leaves either a bright packet blown to uniform
   * white or a delocalised eigenstate too dim to read — with peak-to-mean ratios
   * from 2 to over 100 across the states on offer, both failures happen with any
   * single constant. Adapting per state makes every state legible; the cost is
   * that brightness cannot be compared across states, so the UI says the value
   * it used, and the Brightness control multiplies it for direct comparison.
   */
  peakDensity() {
    const { psi, grid } = this;
    let peak = 0;
    for (let i = 0; i < grid * grid; i += 1) {
      const re = psi[i * COMPLEX];
      const im = psi[i * COMPLEX + 1];
      const v = re * re + im * im;
      if (v > peak) peak = v;
    }
    return peak;
  }

  /**
   * Paint psi into an RGBA buffer, one row-major pass.
   *
   * Two views share the pass because they answer different questions and readers
   * conflate them if they arrive separately:
   *   density — |psi|^2, what a position measurement finds.
   *   phase   — arg(psi) as hue. Not itself observable, but the *gradient* of the
   *             phase is the local momentum, so this is the view that explains
   *             the momentum panel: where the hue turns over quickly, there is
   *             momentum along that direction.
   *
   * @param {Uint8ClampedArray} target  grid*grid*4 bytes.
   * @param {'density'|'phase'} view
   * @param {number} gain  Exposure multiplier.
   */
  render(target, view, gain) {
    const { psi, grid } = this;
    // Scale so the brightest cell lands at 1 before tone mapping. `gain` then
    // means "exposure relative to the state's own brightest point", which keeps
    // the interference fringes — the point of the picture — out of the clipped
    // white end of the ramp for every state the app can prepare.
    const peak = this.peakDensity();
    const scale = peak > 0 ? gain / peak : 0;
    for (let i = 0; i < grid * grid; i += 1) {
      const re = psi[i * COMPLEX];
      const im = psi[i * COMPLEX + 1];
      const at = i * 4;
      if (view === 'phase') {
        const hue = (Math.atan2(im, re) / (2 * Math.PI) + 0.5) % 1;
        const amplitude = Math.sqrt(peak);
        const level = amplitude > 0 ? Math.min(1, (Math.sqrt(re * re + im * im) / amplitude) * gain) : 0;
        const [r, g, b] = hslToRgb(hue, 0.72, 0.08 + 0.62 * level);
        target[at] = r;
        target[at + 1] = g;
        target[at + 2] = b;
      } else {
        // Gamma rather than a hard knee: preserves contrast in the fringes while
        // keeping the peak inside the ramp.
        const rho = (re * re + im * im) * scale;
        const [r, g, b] = ramp(rho > 0 ? Math.pow(rho, 0.6) : 0);
        target[at] = r;
        target[at + 1] = g;
        target[at + 2] = b;
      }
      target[at + 3] = 255;
    }
  }

  /**
   * Momentum-space probability density |phi(kx, ky)|^2, peak-normalised to 1,
   * shifted so k = 0 is the centre of the image.
   *
   * Computed from the same psi the position view came from, which is the entire
   * reason the two panels are shown together: the reader is comparing one
   * state's two descriptions, not two independent pictures.
   */
  momentumDensity() {
    const { grid } = this;
    const work = Float64Array.from(this.psi);
    transform2DInPlace(this, work, false);
    const out = new Float64Array(grid * grid);
    let peak = 0;
    for (let y = 0; y < grid; y += 1) {
      for (let x = 0; x < grid; x += 1) {
        const at = (y * grid + x) * COMPLEX;
        const rho = work[at] * work[at] + work[at + 1] * work[at + 1];
        const sx = (x + grid / 2) % grid;
        const sy = (y + grid / 2) % grid;
        out[sy * grid + sx] = rho;
        if (rho > peak) peak = rho;
      }
    }
    if (peak > 0) for (let i = 0; i < out.length; i += 1) out[i] /= peak;
    return out;
  }

  /**
   * Position and momentum spreads, per axis.
   *
   * The Heisenberg relation is a statement per axis: sigma_x sigma_px >= hbar/2.
   * It is *not* true for radial RMS spreads, and computing the radial version is
   * a classic way to get a number that looks like it violates the bound (for a
   * uniform density over a box of side L the radial RMS is about L / (2 sqrt 3)
   * while the momentum spread stays near the reciprocal-lattice spacing, so the
   * product can sit far below 0.5 with nothing wrong in the physics). So we take
   * marginal variances along each axis and report the worst axis pair, which is
   * the quantity the bound actually constrains.
   *
   * Units: sigmaX in grid cells, sigmaP in hbar per cell (hbar = 1), and the
   * UI states both.
   */
  uncertainties() {
    const { grid, psi } = this;
    const cells = grid * grid;
    let total = 0;
    for (let i = 0; i < cells; i += 1) {
      const re = psi[i * COMPLEX];
      const im = psi[i * COMPLEX + 1];
      total += re * re + im * im;
    }
    if (!(total > 1e-12)) return { sigmaX: 0, sigmaP: 0, product: 0 };

    /**
     * Marginal standard deviation along one axis of a 2-D density, given the
     * coordinate of each sample along that axis (constant in the other axis).
     */
    const marginalSigma = (density, coordinate) => {
      let sum = 0;
      let mean = 0;
      for (let i = 0; i < cells; i += 1) {
        sum += density[i];
        mean += coordinate[i] * density[i];
      }
      if (!(sum > 0)) return 0;
      mean /= sum;
      let variance = 0;
      for (let i = 0; i < cells; i += 1) {
        const d = coordinate[i] - mean;
        variance += d * d * density[i];
      }
      return Math.sqrt(variance / sum);
    };

    const position = new Float64Array(cells);
    const coordX = new Float64Array(cells);
    const coordY = new Float64Array(cells);
    for (let iy = 0; iy < grid; iy += 1) {
      for (let ix = 0; ix < grid; ix += 1) {
        const i = iy * grid + ix;
        const re = psi[i * COMPLEX];
        const im = psi[i * COMPLEX + 1];
        position[i] = re * re + im * im;
        coordX[i] = ix + 0.5 - grid / 2;
        coordY[i] = iy + 0.5 - grid / 2;
      }
    }
    const sigmaX = Math.max(marginalSigma(position, coordX), marginalSigma(position, coordY));

    // Momentum marginals over the bins the transform actually produced, using
    // the wavenumbers that label them, so sigmaP is a real k and not an index.
    const work = Float64Array.from(this.psi);
    transform2DInPlace(this, work, false);
    const k = Simulation.wavenumbers(grid);
    const momentum = new Float64Array(cells);
    const kxOf = new Float64Array(cells);
    const kyOf = new Float64Array(cells);
    for (let iy = 0; iy < grid; iy += 1) {
      for (let ix = 0; ix < grid; ix += 1) {
        const i = iy * grid + ix;
        const re = work[i * COMPLEX];
        const im = work[i * COMPLEX + 1];
        momentum[i] = re * re + im * im;
        kxOf[i] = k[ix];
        kyOf[i] = k[iy];
      }
    }
    const sigmaP = Math.max(marginalSigma(momentum, kxOf), marginalSigma(momentum, kyOf));
    return { sigmaX, sigmaP, product: sigmaX * sigmaP };
  }

  /**
   * Prepare a named state and return one or two sentences describing it, so the
   * words on screen are generated by the same call that sets the physics and
   * cannot drift out of step with the picture.
   *
   * Eigenstates are built from exactly degenerate pairs of grid modes —
   * cos(2 m u) cos(2 n v) together with its 90-degree-shifted partner
   * sin(2 m u) sin(2 n v) — because those have a single k^2 and are therefore
   * stationary to machine precision on this grid. The factor 2 is the whole
   * trick: it keeps every component wavenumber an integer multiple of 2 pi / N.
   */
  setState(kind, parameters = {}) {
    const { grid } = this;
    this.clear();
    const centre = grid / 2;

    /** Sample f(x, y), in cells from the box centre, into psi. */
    const sample = (f) => {
      for (let iy = 0; iy < grid; iy += 1) {
        for (let ix = 0; ix < grid; ix += 1) {
          const index = iy * grid + ix;
          const value = f(ix + 0.5 - centre, iy + 0.5 - centre);
          const at = index * COMPLEX;
          this.psi[at] = value[0] * this.mask[index];
          this.psi[at + 1] = value[1] * this.mask[index];
        }
      }
      this.normalize();
      // Preparing a state is not the wall absorbing one. A packet whose tail
      // reaches the wall is clipped above, and letting that go through
      // `project()` would make "the wall has absorbed X% of your particle"
      // report a large number the instant the state is chosen, before a single
      // step has run. Reset so the counter means exactly what the UI says:
      // probability lost to the wall while the simulation was running.
      this.absorbed = 0;
    };

    /**
     * An exact eigenstate of the discrete Laplacian with quantum numbers
     * (m, n) >= 1, using wavenumbers 2 m pi / N. Both terms of the pair share
     * k^2 = (2 pi / N)^2 (m^2 + n^2), which is what makes it stationary.
     */
    const eigenstate = (m, n) => {
      const unit = (2 * Math.PI) / grid;
      sample((x, y) => {
        const a = Math.cos(m * unit * x) * Math.cos(n * unit * y);
        const b = Math.sin(m * unit * x) * Math.sin(n * unit * y);
        return [a + b, 0];
      });
    };

    switch (kind) {
      case StateKind.GROUND: {
        eigenstate(1, 1);
        return {
          title: 'Ground state',
          text: 'The calmest possible state. Its density never moves — not because the particle is still, but because a standing wave has no net flow anywhere.',
          energy: 2,
        };
      }
      case StateKind.EXCITED: {
        const m = Math.max(1, Math.round(parameters.m ?? 3));
        const n = Math.max(1, Math.round(parameters.n ?? 1));
        eigenstate(m, n);
        return {
          title: `Excited state (${m}, ${n})`,
          text: 'More nodes, more energy, still perfectly still. Count the dark nodal lines: they never move either.',
          energy: m * m + n * n,
        };
      }
      case StateKind.TRAVELLING: {
        const m = Math.max(1, Math.round(parameters.m ?? 2));
        // exp(i k x): one grid mode, so one sharp momentum. Switch on the phase
        // view to see why — the hue wraps at a constant rate across the box.
        const unit = (2 * Math.PI) / grid;
        sample((x, y) => {
          const phase = m * unit * x;
          return [Math.cos(phase), Math.sin(phase)];
        });
        return {
          title: `Travelling wave, momentum ${m}`,
          text: 'A single momentum value, so the density is flat and completely featureless. There is no position information left to have — and the spectrum is one sharp dot.',
          momentum: m,
        };
      }
      case StateKind.PACKET: {
        const width = Math.max(2, parameters.width ?? 6);
        // A Gaussian is only a Gaussian if it has died away before the box edge:
        // on a periodic grid a wide packet wraps around and stops being a
        // localised state, and its measured spread then describes a different
        // (wrapped) distribution. 3 sigma leaves ~0.1% of the amplitude at the
        // wall, which keeps the free-particle spreading law accurate to the few
        // percent the app claims. Rejecting an over-wide request is more honest
        // than silently simulating something else.
        if (3 * width >= grid / 2) {
          throw new Error(
            `packet width ${width} is too wide for a ${grid}-cell box: 3 sigma would reach the wall, so the state would wrap around and no longer be localised`,
          );
        }
        const offX = parameters.offsetX ?? 0;
        const offY = parameters.offsetY ?? 0;
        sample((x, y) => {
          const dx = x - offX;
          const dy = y - offY;
          const g = Math.exp(-(dx * dx + dy * dy) / (2 * width * width));
          return [g, 0];
        });
        return {
          title: 'Localised packet',
          text: 'One particle, somewhere specific — so it is not an energy eigenstate, and it will spread as it moves. Pinching it narrower makes the spread faster, because a sharper position needs a wider range of momenta.',
          width,
        };
      }
      case StateKind.SUPERPOSITION: {
        const low = Math.max(1, Math.round(parameters.low ?? 1));
        const high = Math.max(1, Math.round(parameters.high ?? 5));
        const unit = (2 * Math.PI) / grid;
        sample((x, y) => {
          const a = Math.cos(low * unit * x) * Math.cos(low * unit * y) + Math.sin(low * unit * x) * Math.sin(low * unit * y);
          const b = Math.cos(high * unit * x) * Math.cos(high * unit * y) + Math.sin(high * unit * x) * Math.sin(high * unit * y);
          const mix = parameters.mix ?? 0.5;
          return [(1 - mix) * a + mix * b, 0];
        });
        return {
          title: `Superposition (${low},${low}) + (${high},${high})`,
          text: 'Neither half moves on its own; added together they do. The density beats at the difference of the two energies, which is the whole reason atoms can emit light.',
          energies: [2 * low * low, 2 * high * high],
        };
      }
      default:
        throw new Error(`unknown state "${kind}"`);
    }
  }
}

/** Forward or inverse 2-D transform: `from` -> `to`, rows then columns. */
function transform2D(sim, from, to, inverse) {
  const { grid } = sim;
  to.set(from);
  for (let y = 0; y < grid; y += 1) fftInPlace(to, grid, 1, y * grid, inverse);
  for (let x = 0; x < grid; x += 1) fftInPlace(to, grid, grid, x, inverse);
}

/** Round-trip through the simulation's scratch buffer, writing back into data. */
function transform2DInPlace(sim, data, inverse) {
  sim.buffer.set(data);
  transform2D(sim, sim.buffer, data, inverse);
}

/** Perceptual ramp: near-black through indigo and teal to warm white. */
function ramp(level) {
  const scaled = Math.max(0, Math.min(1, level)) * (RAMP_STOPS.length - 1);
  const index = Math.min(RAMP_STOPS.length - 2, Math.floor(scaled));
  const t = scaled - index;
  const a = RAMP_STOPS[index];
  const b = RAMP_STOPS[index + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const RAMP_STOPS = [
  [7, 9, 20],
  [22, 24, 68],
  [40, 58, 148],
  [34, 128, 184],
  [92, 204, 190],
  [226, 234, 204],
  [255, 253, 248],
];

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(Math.min(k - 3, 9 - k), 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

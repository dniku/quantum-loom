# Quantum Loom

[![CI](https://github.com/dniku/quantum-loom/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/dniku/quantum-loom/actions/workflows/check.yml) **[▶ Play it live](https://raw.githack.com/dniku/quantum-loom/main/index.html)**

One quantum particle, in a flat box, simulated rather than faked — and the Fourier transform that makes it behave strangely.

Drag anywhere on the picture to place the particle and send it moving. Watch it spread, watch a standing wave refuse to move, and watch what confining it to a small region does to its momentum. Nothing here is a recorded animation: the [Schrödinger equation](https://en.wikipedia.org/wiki/Schr%C3%B6dinger_equation) is solved for the state on screen, every frame.

![Desktop: a wave packet with its momentum spectrum beneath it](docs/readme-desktop.png)

## What you are looking at

The main picture is a probability density, |ψ(x, y)|². Bright means you are likely to find the particle there, dark means you are not. The small panel beneath it is the *same* state described in momentum instead of position — the Fourier transform of the first picture — so the two are always in step, and anything you see trade off between them is real.

Two rules drive everything you will see:

- **A state of definite energy does not move.** These are the standing waves. Their density is frozen, even though the particle inside is anything but still.
- **A wave confined to a small region needs many wavelengths.** That is not a quirk of quantum mechanics, it is a property of the Fourier transform that applies to sound and water too. Confinement forces a broad range of momenta. This is the entire reason a particle cannot both sit still and stay in one place, and the two panels show it directly.

## Controls

| Control | What it does |
| --- | --- |
| **Drag on the picture** | Place the particle and give it a push. A tap drops it nearly still; a long, sharp flick gives it definite momentum — and, because sharper momentum means less definite position, a *harder* flick produces a *wider* blob. |
| **Prepare a state** | Wave packet (localised, spreads), Lowest standing wave and Standing wave (energy eigenstates, frozen), Travelling wave (one momentum, flat density), Superposition (two eigenstates added, so the density beats). |
| **Picture shows** | Density (|ψ|², what position measurement finds) or Phase (the direction the wave is waving — not directly measurable, but where the colours churn fastest is where momentum points, which is what makes the momentum panel legible). |
| **Edges of the box** | Periodic (the grid wraps, nothing is lost, probability is conserved exactly) or walls (a genuinely different system: the wall absorbs what hits it, and the readout counts how much). |
| **Sliders** | Energy of the standing wave, wall position, simulation speed, and exposure. |

Works with a mouse and with touch, in portrait and landscape; the layout reflows to keep the picture and its momentum companion together.

## How the simulation works

The particle obeys `iħ ∂ψ/∂t = −(ħ²/2m)∇²ψ` in atomic units (ħ = m = 1). It is advanced with a **spectral method**: the discrete Laplacian is exactly diagonal in the Fourier basis, so one step multiplies every wavenumber by its exact phase `exp(−i|k|² dt / 2)` and transforms back.

That is not an approximation of the time evolution — it is the exact solution of the discretised equation for any `dt`, because the kinetic operator is diagonal in that basis. The multiplier has unit modulus, so total probability is conserved to floating-point round-off (measured drift ~1e-12 over hundreds of steps) with no damping term anywhere. This is why a standing wave genuinely stands still rather than slowly decaying, and it is checked, not asserted.

Two modelling choices are stated rather than hidden:

- **The box is periodic.** Stationarity — the app's central claim — needs eigenstates the grid can represent exactly, and on a periodic grid that means states whose Fourier support lies in a single degenerate energy shell. The standing waves are built as products of grid modes chosen for exactly that reason. A sub-box with hard walls is *not* band-limited on a periodic grid, and was measured to disperse (density drift of 1e-2 to 2e-1 over a few hundred steps), which is why it is offered as an explicit, labelled absorbing-wall mode rather than passed off as the clean case.
- **Exposure adapts per state.** Peak-to-mean density spans 2× to 100× across the states on offer, so no single fixed exposure shows them all; each state is shown against its own peak, and the value is surfaced and user-adjustable.

## Running it

`index.html` is a single self-contained file: no network, no dependencies, no storage, works offline and from `file://`. It embeds its own font faces, so nothing is fetched at runtime — not even a typeface. Open it directly in a browser.

```sh
# build index.html from the modular sources in src/
nix build            # or: nix develop --command node tools/build.mjs

# open it
xdg-open index.html
```

## Playing it online

**<https://raw.githack.com/dniku/quantum-loom/main/index.html>** runs the page straight out of this repo — no build, no hosting — which works only because the page is one file that asks for nothing else. That it really is this file is worth checking rather than taking on faith:

```bash
curl -s https://raw.githack.com/dniku/quantum-loom/main/index.html | sha256sum
sha256sum index.html                             # same digest
```

Two things to expect. rawgithack puts a one-time **External Content Notice** in front of any HTML it proxies, with an *Open the page* button: the toy is behind that click, and it remembers. And it caches for about a minute, so a fresh push takes a moment to appear — `rawcdn.githack.com` is the edge-cached mirror of the same path, and a commit SHA instead of `main` gives a link that cannot move. It is somebody else's server, so it is a demo path; the file in this repo is the artifact.

`raw.githubusercontent.com` will not work, and not for the usual reason: GitHub serves it as `text/plain` with `content-security-policy: default-src 'none'; sandbox`, and Chromium runs no script from it whatsoever. Stripping that is the whole job rawgithack exists to do.

## Development and testing

Everything is pinned by `flake.lock`, so local and CI resolve the same node, Playwright, and browsers.

```sh
nix develop --command ./check.sh              # full acceptance checklist (Firefox)
nix develop --command ./check.sh --engine chromium
```

`check.sh` runs every phase or fails the build — a phase that cannot run is red, never a silent skip:

1. **Build** the artifact (tests read the artifact, so a stale one cannot pass).
2. **Syntax** check of every source, tool, test, and the inlined artifact.
3. **Artifact self-containment** — no external references, no `type="module"` (which would not run from `file://`), inline script parses.
4. **Physics** — the model against facts true independently of it: analytic eigenmode phase, probability conservation, eigenstate stationarity versus superposition evolution, the analytic Gaussian spreading law to 2%, the per-axis Heisenberg bound, spectral peaks on the reciprocal lattice, exact wall-absorption accounting. No browser needed.
5. **Interaction** — the built page driven through its interface, asserting observable results (a drag moves the particle and explains itself, a narrow packet spreads, `hidden` controls actually hide, no page errors).
6. **Golden screenshots** — byte comparison of 7 reviewed baselines across desktop and both phone orientations, plus the physics states.

`nix flake check` and `nix build` were verified against the pinned nixpkgs; the
full `nix develop --command ./check.sh` runs the identical command in CI. Local
development and every result quoted above ran on Firefox (the reliable engine in
this container — Chromium's headless sandbox needs syscalls it denies), and both
engines are selectable with `--engine`.

### Why the page ships its own font

The stylesheet used to ask for `system-ui`, and the golden suite paid for it: CI's Firefox resolved that to a different face than this container's, glyph advances shifted, and the three full-page baselines failed there while all four canvas-only ones passed — the canvas carries no text, so only the painted words disagreed.

So the artifact embeds two subset WOFF2 faces (Regular and Bold, ~15 KiB together) as data URIs and asks for them by one family name. Nothing on the host is consulted, which makes a baseline mean the same pixels on any machine — and is simply what "one file that works offline" requires, since a font fetched from the operating system is still an external dependency. Both weights are embedded because the sheet asks for 550 and 600 too, and with a single face each engine synthesises its own bold, whose stem weight varies by engine: the same drift, arriving by a different route.

The subset covers Latin-1 plus the physics symbols the copy uses (`ħ`, `σ`, `ψ`, `×`, `–`, `—`, `²`), which is a contract rather than an accident — a glyph missing from the subset falls back silently for that one character and changes a line's width, reappearing only on a machine with different fonts. `tools/build-font.mjs` regenerates the faces from the pinned nixpkgs and asserts the WOFF2 signature; `check-artifact.mjs` asserts the built page contains both faces as inline data URIs, so the fix cannot rot quietly into a fallback stack.

```sh
./tools/with-fonttools.sh    # regenerates build/*.woff2.base64; not needed to build, test, or view
```

Regenerate and **review** baselines after an intentional visual change (a byte-equal screenshot proves pixels did not change, not that they look right — each new baseline is viewed before it is accepted):

```sh
nix develop --command ./check.sh --update
```

The golden suite reuses one browser per scene and takes about a minute; the physics and interaction suites are quick.

## Repository layout

```
src/            quantum.js (physics) · app.js (UI) · styles.css · index.template.html
tools/          build-lib.mjs (inliner) · browser.mjs (Playwright harness) · build-font.mjs · checks
build/          committed base64 WOFF2 subsets read by the inliner
tests/          physics · interaction · golden, plus tests/golden/*.png baselines
docs/           README screenshots
index.html      the built, self-contained artifact
```

## Honest limitations

- It is 2-D, one particle, spinless, non-relativistic, and the box is periodic by choice (see above).
- Colours are a chosen perceptual ramp; brightness is adaptive, so it is not a fixed scale for comparing one state to another by eye.
- Momentum is read as |φ(k)|²; the app does not measure individual momentum outcomes, it shows the distribution.

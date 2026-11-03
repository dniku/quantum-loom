{
  description = "Quantum Loom: an interactive 2-D quantum particle and its Fourier transform";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # Goldens are painted and compared inside a single browser process, so the
      # set of systems is not cosmetic: each needs the same browser build for a
      # baseline to mean the same pixels. Only Linux is exercised by CI.
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.playwright-driver
            pkgs.git
            pkgs.python3
          ];

          env = {
            # ESM ignores NODE_PATH, so the driver is addressed by absolute path.
            # The entry is index.mjs at the top level of the driver package, not
            # package/index.mjs: playwright-driver does not use the node2nix
            # layout, and guessing the prefix yields an import that resolves to
            # nothing and only fails at runtime.
            PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/index.mjs";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          };

          shellHook = ''
            echo "Quantum Loom: ./check.sh    (build, syntax, physics, browser, goldens)"
          '';
        };
      });

      packages = forAllSystems (pkgs: {
        # The artifact alone: build from source, keep only the single file the
        # project ships. `nix build` producing something other than exactly
        # index.html would mean the bundler had started emitting siblings.
        default = pkgs.runCommand "quantum-loom" {
          src = ./.;
          nativeBuildInputs = [ pkgs.nodejs_22 ];
        } ''
          # Build into $out rather than running in $src: a Nix source tree is a
          # read-only store path, so writing the artifact beside the sources
          # fails with EACCES. tools/build.mjs takes the output path for this.
          node "$src/tools/build.mjs" "$out/index.html"
          test -s "$out/index.html"
          # The artifact must be self-contained: no external asset references.
          ! grep -qE '<(script|link|img)[^>]+(src|href)="[^#]' "$out/index.html" \
            || { echo "artifact references an external file"; exit 1; }
        '';
      });
    };
}

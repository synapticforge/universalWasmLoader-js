# npm — a second registry beside JSR (2026-10-21)

🔒 Owner, 2026-10-21: "We will also need to setup an npm repository just as we did for binaryang.
see that project for proper setup." **JSR stays the source**; npm is added beside it. Modelled on
binaryang (`../binaryang/cmem/publishing.md` § "npm as a SECOND registry", `scripts/npm/`), read,
not copied: this package is hand-written JavaScript + `.d.ts`, so nothing is compiled.

## The package

| | |
| --- | --- |
| name | **`@synapticforge1/universal-wasm-loader`** — npm org `synapticforge1` (binaryang's pattern: npm org + the JSR package name). FREE on registry.npmjs.org on 2026-10-21 (404) |
| contents | exactly JSR's `publish.include` (the 4 `.js` + 4 `.d.ts`, README, SPEC) + `LICENSE`; 12 files, 16.8 KiB (2026-10-21) |
| manifest | `dist/package.json` GENERATED from `jsr.json` by `scripts/npm/build.ts` `npmManifest()`: the version has one source; `exports: { ".": { types, default } }` (types read from the file's `@ts-self-types`), `license: MIT`, `engines.node >=22.18`, repository / homepage / bugs on `synapticforge1/universalWasmLoader-js`, `publishConfig: { access: public, provenance: true }`. No `bin`. The repo's own `package.json` stays private (`bun run manifest`) |
| reference | JSR's own npm build (`npm.jsr.io/@jsr/jrmarcum__universal-wasm-loader`) has the same files minus LICENSE plus `jsr.json`, and the same single `.` export |

## Build and proof

- `bun run npm:build [--tag vX.Y.Z]` → `dist/` (gitignored). `--tag` builds from that release's
  OWN files (`git archive` into `.npm-src/`, deleted after) so an npm version holds the same code as
  the JSR version of that number. Checked 2026-10-21: `--tag v1.1.0` gives 11 files byte-identical
  to `v1.1.0` (git blob ids).
- `bun run npm:prove [--tag vX.Y.Z]` (in CI's Gates, on Node 24 + Bun): builds, `npm pack`s,
  installs the TARBALL into a scratch consumer outside the repo, then: only the expected files and
  every path the manifest names; exports equal `jsr.json`'s; on Node 22 / 24 / 26 (each fnm line;
  `node` from PATH without fnm, as in CI) and Bun, the installed package LOADS `math_50` and
  `strings_50` through `wasmImport`, `createSingleton`, `InstancePool` (strings run `cabi_realloc`
  and `cabi_post_<name>`); a TypeScript consumer (`nodenext`, `types: []`) type-checks against the
  shipped `.d.ts`; the installed package bundles for the browser AND its `.js` has no top-level
  `node:` import (the bundle alone cannot see one: best-practices L1); the export list equals JSR's
  npm build. `dist/` is left for the publish step.
- npm on Windows is a `.cmd` shim that `fnm exec` cannot spawn, so the proof runs
  `node <npm-cli.js>` beside the chosen Node (binaryang, measured).

**Inverted 2026-10-21, 6 of 6 caught for the right reason** (scratch clone; driver
`npm-mutants.ts` in the session scratchpad): a retyped `wasmImport` parameter in the `.d.ts` →
the consumer type check (TS2345); `abi.js` left out of `publish.include` → `ERR_MODULE_NOT_FOUND`
on every runtime; string returns one byte short → `greet("World"): got "Hello, World"`; a
top-level `node:fs` import → the source scan; a wrong `types` path → "names files the tarball
lacks"; `jsr.json` shipped → "unexpected files". Two first attempts were bad: removing `export`
from a `.d.ts` type changes nothing (declarations in a module `.d.ts` are exported anyway), and a
clone without `typescript` installed made every type check fail for the wrong reason.

## The release path

`publish.yml` job **`npm`**: after the JSR job, the same tag; `run:` steps; Node 24 + npm 11 via
fnm; tag = `jsr.json` version; `npm:prove`; `npm publish` from `dist/` by **trusted publishing**
(GitHub OIDC, `id-token: write`, no token; npm ≥ 11.5); then the provenance attestation read back
from registry.npmjs.org (`dist.attestations.provenance.predicateType`, cache-busted). **OFF until
the repository variable `NPM_PUBLISH` is `true`.** Versions are immutable on both registries: a
failed npm job is re-run alone, never re-tagged.

## ✅ 1.1.0 on npm, published by hand (2026-10-21T23:03:05Z)

By the owner, from `dist/` built and proved with `npm:prove --tag v1.1.0` (11 files byte-identical
to the tag; npm 12.2.0, user `synapticforgeun`, `--provenance=false`). The public metadata
answered 404 for about a minute after the publish (binaryang saw the same). Checked as a user
from registry.npmjs.org: `npm install @synapticforge1/universal-wasm-loader@1.1.0`, then
`math_50` and `strings_50` load through `wasmImport` / `createSingleton` on Node 22, 24, 26 and
Bun. Trusted publisher and `NPM_PUBLISH`: the owner's (not readable from here: `npm trust list`
asks for a fresh one-time password on every call; repository variables need GitHub auth); the
1.1.1 release's `npm` job is their proof.

On this machine npm runs as `fnm exec --using=24 cmd /c npm …` (`fnm exec npm` cannot start the
`.cmd` shim).

## 1.1.1 (2026-10-21): JSR published, npm job SKIPPED

`bun run bump patch` (gate: floor patch, v1.1.0's tests 24/24), `Release v1.1.1` `b706cc6`,
`bun run release`. Publish run 39691735587: the JSR job green — **JSR 1.1.1 rekorLogId
`3367515417`**, latest, score 100, the first JSR provenance from the `synapticforge1` org; CI
green. **The `npm` job was SKIPPED:** `vars.NPM_PUBLISH == 'true'` was false although the owner
had "added a secret". A SECRET is invisible to `vars.`; it must be a repository VARIABLE (or an
org variable granted to this repo) with the value `true`. GitHub compares strings
case-insensitively, so the value's case is not the cause.

Re-running that run cannot help (it uses the workflow AT the tag, and its JSR job would fail on
the existing 1.1.1), so `publish.yml` gained a **`workflow_dispatch`** with a `tag` input (owner's
choice, 2026-10-21): it runs ONLY the npm job, for a release tag JSR already has (checked against
`api.jsr.io` first; the input reaches the shell through an env var and must match `vX.Y.Z`). Same
workflow file name, so the trusted publisher still matches. ⏳ Owner: set the variable, then
Actions → Publish → Run workflow → `v1.1.1`; the job's provenance read-back is the proof.
npmjs.org also lists a `0.0.0-stage` version not published from here (seen 2026-10-21); the
owner's to explain.

## Left to the owner, in order (binaryang's experience, `publishing.md` § 1.13.1)

1. **The first version by hand** — npm's trusted publisher is configured on the PACKAGE, which must
   already exist. As `synapticforgeun`: `bun run npm:prove --tag v1.1.0` (builds `dist/` from the
   v1.1.0 tree and proves it), then `npm login`, then from `dist/`:
   `npm publish --provenance=false` (the manifest asks for provenance, which only CI can produce;
   this one version goes without it, as binaryang's 1.13.1 did).
2. **The trusted publisher** on that package: GitHub Actions, repository
   `synapticforge1/universalWasmLoader-js`, workflow `publish.yml` — on the package's settings page
   (Packages → the package → Settings → Trusted publishing) or
   `npm trust github @synapticforge1/universal-wasm-loader --file publish.yml --repo synapticforge1/universalWasmLoader-js --allow-publish`
   (npm ≥ 11.15).
3. **The repository variable `NPM_PUBLISH=true`** on GitHub.
4. **A release within 2 days** of step 2: npm requires a new trusted-publisher configuration to
   complete a publish within 2 days (binaryang's record). `main` already holds a patch's worth
   (the `checkJs` fixes and the two null-memory errors since 1.1.0), so the next release can be
   1.1.1. Its `npm` job and provenance read-back are the proof of steps 2 and 3.

Then the README gains the npm install route (binaryang did this once the package was on npm).

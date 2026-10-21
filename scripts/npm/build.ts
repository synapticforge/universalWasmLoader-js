/**
 * The npm package, built into `dist/` (owner, 2026-10-21: "setup an npm repository just as we did
 * for binaryang"; JSR stays the source). Nothing here publishes. Modelled on binaryang's
 * `scripts/npm/build.ts`, simpler: this loader is hand-written JavaScript + `.d.ts`, so nothing is
 * compiled. The package is exactly what JSR ships (`jsr.json` `publish.include`) plus `LICENSE`,
 * with a `package.json` GENERATED from `jsr.json` ({@link npmManifest}), so the version has ONE
 * source and the repo's own `package.json` stays private.
 *
 * ```sh
 * bun run npm:build                 # from the working tree
 * bun run npm:build --tag v1.1.0    # from a RELEASED tag's own files (the first, manual publish)
 * ```
 *
 * `--tag` exists because an npm version must hold the same code as the JSR version of that
 * number: built from `main`, "1.1.0" would carry whatever landed after the 1.1.0 tag.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The package's name on npmjs.org: the npm org `synapticforge1` (as binaryang's). JSR's name is `@jrmarcum/universal-wasm-loader`. */
export const NPM_NAME = "@synapticforge1/universal-wasm-loader";

/** The Node floor the README states and CI tests (22.18). */
export const NODE_FLOOR = ">=22.18";

/** The GitHub repository (owner-controlled organization since 2026-10-21). */
export const REPO = "synapticforge1/universalWasmLoader-js";

/** What `jsr.json` holds that the npm manifest is generated from. */
export interface JsrManifest {
  version: string;
  exports: string | Record<string, string>;
  publish: { include: string[] };
}

/** `./x.js` → its `@ts-self-types` `.d.ts`, read from the file itself (`root`-relative). */
function typesOf(root: string, js: string): string {
  const src = readFileSync(join(root, js), "utf8");
  const dts = src.match(/@ts-self-types\s*=\s*"\.\/([^"]+)"/)?.[1];
  if (!dts) throw new Error(`${js} has no @ts-self-types: its types are unknown`);
  return `./${dts}`;
}

/** The npm `package.json` for `dist/`, from `jsr.json`: the same version and the same exports. */
export function npmManifest(root: string, jsr: JsrManifest): Record<string, unknown> {
  const map = typeof jsr.exports === "string" ? { ".": jsr.exports } : jsr.exports;
  const exports: Record<string, { types: string; default: string }> = {};
  for (const [sub, file] of Object.entries(map)) {
    if (!file.endsWith(".js")) throw new Error(`jsr.json export ${sub} is not a .js file: ${file}`);
    const js = file.startsWith("./") ? file : `./${file}`;
    exports[sub] = { types: typesOf(root, js), default: js };
  }
  const main = exports["."];
  if (main === undefined) throw new Error('jsr.json has no "." export');
  return {
    name: NPM_NAME,
    version: jsr.version,
    description:
      "A zero-dependency WebAssembly loader: load a .wasm like an ES import, with its .wit applied " +
      "through the Canonical ABI. Node, Bun, Deno and browsers. Also on JSR as " +
      "@jrmarcum/universal-wasm-loader.",
    license: "MIT",
    type: "module",
    exports,
    types: main.types,
    engines: { node: NODE_FLOOR },
    repository: { type: "git", url: `git+https://github.com/${REPO}.git` },
    homepage: `https://github.com/${REPO}#readme`,
    bugs: { url: `https://github.com/${REPO}/issues` },
    keywords: ["webassembly", "wasm", "wit", "component-model", "canonical-abi", "loader", "wasi"],
    sideEffects: false,
    publishConfig: { access: "public", provenance: true },
  };
}

/** Builds the package from the tree at `root` into `dist`; returns the manifest it wrote. */
export function build(root: string, dist: string): Record<string, unknown> {
  const jsr = JSON.parse(readFileSync(join(root, "jsr.json"), "utf8")) as JsrManifest;
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  // jsr.json itself is JSR's manifest, not part of the package.
  for (const f of [...jsr.publish.include, "LICENSE"]) {
    if (!existsSync(join(root, f))) throw new Error(`${f} (to ship) does not exist`);
    copyFileSync(join(root, f), join(dist, f));
  }
  const manifest = npmManifest(root, jsr);
  writeFileSync(join(dist, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Extract the tree of release `tag` into `dir` (fresh); fails when the tag predates jsr.json. */
export function extractTag(repo: string, tag: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = join(dir, "tree.tar");
  const a = spawnSync("git", ["archive", "--format=tar", "-o", tar, tag], { cwd: repo, encoding: "utf8" });
  if (a.status !== 0) throw new Error(`git archive ${tag}: ${(a.stderr || a.error?.message || "").trim()}`);
  const x = spawnSync("tar", ["-xf", tar, "-C", dir], { encoding: "utf8" });
  if (x.status !== 0) throw new Error(`tar: ${x.stderr}`);
  rmSync(tar);
  if (!existsSync(join(dir, "jsr.json"))) throw new Error(`${tag} has no jsr.json (before 1.1.0): not buildable`);
}

const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === process.argv[1].replace(/\\/g, "/");
if (isMain) {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const at = process.argv.indexOf("--tag");
  const tag = at > 0 ? process.argv[at + 1] : undefined;
  try {
    let root = repo;
    if (tag !== undefined) {
      root = join(repo, ".npm-src");
      extractTag(repo, tag, root);
    }
    const m = build(root, join(repo, "dist"));
    if (tag !== undefined && `v${m.version}` !== tag) throw new Error(`${tag} holds version ${m.version}`);
    console.log(`built ${m.name}@${m.version} into dist/${tag ? ` from ${tag}` : ""}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    if (tag !== undefined) rmSync(join(repo, ".npm-src"), { recursive: true, force: true });
  }
}

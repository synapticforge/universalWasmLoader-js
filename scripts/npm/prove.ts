/**
 * Proves the npm TARBALL, not the tree (owner, 2026-10-21; modelled on binaryang's
 * `scripts/npm/prove.ts`): builds `dist/`, packs it, installs the tarball into a scratch consumer
 * OUTSIDE the repo, and checks what a user of `@synapticforge1/universal-wasm-loader` gets.
 * Nothing is published; `dist/` is left in place for a publish step.
 *
 * - the tarball holds only the shipped `.js` / `.d.ts`, `package.json`, README, SPEC and LICENSE,
 *   and every path the manifest names; its exports equal `jsr.json`'s;
 * - on every runtime (each Node LTS line fnm has, else `node` from PATH; and Bun): the package
 *   imports, and LOADS real fixtures — `math_50` (numbers) and `strings_50` (string params and
 *   callee-allocated returns, so `cabi_realloc` and `cabi_post_<name>` run) — through `wasmImport`,
 *   `createSingleton` and `InstancePool`;
 * - the types: a TypeScript consumer (`moduleResolution: nodenext`, no `@types/node`) type-checks
 *   against the shipped `.d.ts`;
 * - the browser: the INSTALLED package bundles for the browser with no top-level `node:` import;
 * - the export list equals JSR's own npm build of the same version (`npm.jsr.io`) — reported, not
 *   failed, when that version or registry is out of reach.
 *
 * ```sh
 * bun run npm:prove                 # the working tree
 * bun run npm:prove --tag v1.1.0    # a released tag's own files (before the first, manual publish)
 * ```
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build, extractTag, NPM_NAME } from "./build.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const dist = join(repo, "dist");
const problems: string[] = [];
const fail = (what: string) => {
  problems.push(what);
  console.log(`FAIL ${what}`);
};
const ok = (what: string) => console.log(`ok   ${what}`);

/** Through fnm when it is on PATH (this machine), on that Node major; else `node` from PATH (CI). */
const hasFnm = spawnSync("fnm", ["--version"], { stdio: "ignore" }).status === 0;
function onNode(major: number | null, cmd: string[], cwd: string): SpawnSyncReturns<string> {
  const [first, ...rest] = cmd;
  if (first === undefined) throw new Error("empty command");
  const [bin, args] = major !== null && hasFnm ? ["fnm", ["exec", `--using=${major}`, ...cmd]] : [first, rest];
  return spawnSync(bin, args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
}
const out = (r: SpawnSyncReturns<string>) => `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();

/**
 * npm, as `node <npm-cli.js>` under the same Node: on Windows `npm` is a `.cmd` shim that neither
 * `fnm exec` nor a shell-less spawn can start (binaryang, measured). npm sits beside node
 * (Windows) or in `../lib/node_modules` (Linux, macOS).
 */
function npm(major: number | null, args: string[], cwd: string): SpawnSyncReturns<string> {
  const find = onNode(major, [
    "node",
    "-p",
    "const p=require('path'),fs=require('fs'),d=p.dirname(process.execPath);" +
      "[p.join(d,'node_modules/npm/bin/npm-cli.js'),p.join(d,'../lib/node_modules/npm/bin/npm-cli.js')]" +
      ".find((f)=>fs.existsSync(f))",
  ], cwd);
  const cli = (find.stdout ?? "").trim();
  if (find.status !== 0 || cli === "" || cli === "undefined") throw new Error(`npm-cli.js not found beside node: ${out(find)}`);
  return onNode(major, ["node", cli, ...args], cwd);
}

/** One file's text from an uncompressed tar: 512-byte headers, name at 0, octal size at 124. */
function tarFile(tar: Uint8Array, name: string): string {
  const text = new TextDecoder();
  for (let p = 0; p + 512 <= tar.length;) {
    const header = tar.subarray(p, p + 512);
    const n = text.decode(header.subarray(0, 100)).replace(/\0.*$/s, "");
    if (n === "") break;
    const size = Number.parseInt(text.decode(header.subarray(124, 136)).replace(/\0.*$/s, "").trim(), 8);
    if (n === name) return text.decode(tar.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} is not in the tarball`);
}

/** The Node majors to prove on: every LTS line fnm has (22, 24, 26), or PATH's `node` alone. */
function nodeMajors(): (number | null)[] {
  if (!hasFnm) return [null];
  const list = spawnSync("fnm", ["list"], { encoding: "utf8" }).stdout ?? "";
  const have = new Set([...list.matchAll(/\bv(\d+)\.\d+\.\d+/g)].map((m) => Number(m[1])));
  return [22, 24, 26].filter((m) => have.has(m));
}

/** What a consumer runs: the published API on real fixtures. Prints `RUN ok` or throws. */
const RUN = `import { wasmImport, createSingleton, InstancePool } from "${NPM_NAME}";
const at = (f) => new URL("./fixtures/" + f, import.meta.url);
const eq = (what, got, want) => { if (got !== want) throw new Error(what + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want)); };
const math = await wasmImport(at("math_50.wasm"));
eq("add(3,4)", math.add(3, 4), 7);
eq("multiply(2.5,4)", math.multiply(2.5, 4), 10);
const strings = await wasmImport(at("strings_50.wasm"));
eq('greet("World")', strings.greet("World"), "Hello, World!");
eq('strLen("hello")', strings.strLen("hello"), 5);
const one = createSingleton(at("math_50.wasm"));
eq("singleton identity", await one(), await one());
const pool = new InstancePool(at("math_50.wasm"), {}, 2);
eq("pool.run", await pool.run((m) => m.square(4)), 16);
console.log("RUN ok");
`;

/** A consumer type-checking against the shipped `.d.ts`. */
const TYPES = `import { wasmImport, createSingleton, InstancePool, type HostCallbacks, type ModuleExports } from "${NPM_NAME}";
const callbacks: HostCallbacks = { envMul: (a, b) => (a as number) * (b as number) };
export const loaded: Promise<WebAssembly.Exports | ModuleExports> = wasmImport("./mod.wasm@2", callbacks);
export const single: () => Promise<WebAssembly.Exports | ModuleExports> = createSingleton(new URL("file:///mod.wasm"));
export const ran: Promise<number> = new InstancePool("./mod.wasm", {}, 2).run(() => 1);
`;

const at = process.argv.indexOf("--tag");
const tag = at > 0 ? process.argv[at + 1] : undefined;
const work = mkdtempSync(join(tmpdir(), "uwl-npm-"));
const tagRoot = join(repo, ".npm-src");
try {
  // 1. Build (from the tree, or from a tag's own files) and pack.
  let root = repo;
  if (tag !== undefined) {
    extractTag(repo, tag, tagRoot);
    root = tagRoot;
  }
  const manifest = build(root, dist);
  const version = String(manifest.version);
  if (tag !== undefined && `v${version}` !== tag) throw new Error(`${tag} holds version ${version}`);
  const exportsMap = manifest.exports as Record<string, { types: string; default: string }>;
  const pack = npm(24, ["pack", "--json", "--pack-destination", work], dist);
  if (pack.status !== 0) throw new Error(`npm pack failed: ${out(pack)}`);
  type Packed = { filename: string; files: { path: string }[]; size: number };
  // npm 10 prints an array of packages; npm 11 an object keyed by package name (binaryang, measured).
  const json = JSON.parse(pack.stdout) as Packed[] | Record<string, Packed>;
  const packed = (Array.isArray(json) ? json : Object.values(json))[0];
  if (packed === undefined) throw new Error("npm pack reported no package");
  const tarball = join(work, packed.filename);
  const files = packed.files.map((f) => f.path);
  const unexpected = files.filter((f) => !/\.(js|d\.ts)$/.test(f) && !["package.json", "README.md", "SPEC.md", "LICENSE"].includes(f));
  if (unexpected.length > 0) fail(`tarball holds unexpected files: ${unexpected.join(", ")}`);
  for (const must of ["package.json", "README.md", "SPEC.md", "LICENSE"]) {
    if (!files.includes(must)) fail(`tarball lacks ${must}`);
  }
  const named = [String(manifest.types), ...Object.values(exportsMap).flatMap((e) => [e.types, e.default])];
  const missing = [...new Set(named)].filter((p) => !files.includes(p.replace(/^\.\//, "")));
  if (missing.length > 0) fail(`the manifest names files the tarball lacks: ${missing.join(", ")}`);
  const jsr = JSON.parse(readFileSync(join(root, "jsr.json"), "utf8")) as { exports: string | Record<string, string> };
  const jsrSubs = (typeof jsr.exports === "string" ? ["."] : Object.keys(jsr.exports)).sort().join(" ");
  if (Object.keys(exportsMap).sort().join(" ") !== jsrSubs) fail(`the manifest's exports differ from jsr.json's`);
  if (problems.length === 0) ok(`packed ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(1)} KiB`);

  // 2. A consumer outside the repo, installing the TARBALL, with fixtures from the same tree.
  const consumer = join(work, "consumer");
  mkdirSync(join(consumer, "fixtures"), { recursive: true });
  writeFileSync(join(consumer, "package.json"), '{ "private": true, "type": "module" }\n');
  for (const f of ["math_50.wasm", "math_50.wit", "strings_50.wasm", "strings_50.wit"]) {
    copyFileSync(join(root, "tests", f), join(consumer, "fixtures", f));
  }
  const install = npm(24, ["install", "--no-audit", "--no-fund", tarball], consumer);
  if (install.status !== 0) throw new Error(`npm install of the tarball failed: ${out(install)}`);
  ok("installed into a scratch consumer");

  // 3. It loads and runs real modules, on every runtime.
  writeFileSync(join(consumer, "run.mjs"), RUN);
  const runtimes: { name: string; run: (cmd: string[]) => SpawnSyncReturns<string> }[] = [
    ...nodeMajors().map((m) => ({
      name: m === null ? "node (PATH)" : `Node ${m}`,
      run: (cmd: string[]) => onNode(m, ["node", ...cmd], consumer),
    })),
    { name: "Bun", run: (cmd: string[]) => spawnSync("bun", cmd, { cwd: consumer, encoding: "utf8" }) },
  ];
  for (const rt of runtimes) {
    const r = rt.run([join(consumer, "run.mjs")]);
    // The thrown message: Node prints `Error: …` (or `Error [CODE]: …`), Bun `error: …`; skip the
    // echoed source line, which also contains "Error".
    const why = out(r).split("\n").find((l) => /^(?:[A-Z]\w*)?[Ee]rror\b/.test(l.trimStart())) ?? out(r).split("\n").slice(-3).join(" | ");
    if (r.status !== 0 || !(r.stdout ?? "").includes("RUN ok")) fail(`${rt.name}: ${why.trim()}`);
    else ok(`${rt.name}: the installed package loads math_50 and strings_50 (wasmImport, createSingleton, InstancePool)`);
  }

  // 4. The types, as a consumer with no @types/node sees them.
  writeFileSync(join(consumer, "types.ts"), TYPES);
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "esnext",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["esnext", "dom"],
          types: [],
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        files: ["types.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const types = spawnSync("bun", [join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", join(consumer, "tsconfig.json")], {
    cwd: consumer,
    encoding: "utf8",
  });
  if (types.status !== 0) fail(`the shipped .d.ts do not type-check for a consumer: ${out(types).split("\n").slice(0, 6).join(" | ")}`);
  else ok("a TypeScript consumer type-checks against the shipped .d.ts");

  // 5. The browser, from the INSTALLED package.
  const pkg = join(consumer, "node_modules", ...NPM_NAME.split("/"));
  const bundle = join(work, "browser.js");
  const b = spawnSync("bun", ["build", join(pkg, "universal-wasm-loader.js"), "--target=browser", "--format=esm", `--outfile=${bundle}`], {
    encoding: "utf8",
  });
  const staticNode = b.status === 0 ? (readFileSync(bundle, "utf8").match(/(?:\bfrom\s*|\brequire\(\s*)["']node:[\w/]+["']/g) ?? []) : [];
  // The bundle alone is blind to a top-level `node:fs` import, which Bun stubs out
  // (best-practices L1), so the installed SOURCE is read as well.
  const sourceNode = files
    .filter((f) => f.endsWith(".js"))
    .flatMap((f) => (readFileSync(join(pkg, f), "utf8").match(/^\s*(?:import|export)\b[^(;]*?["']node:[\w/]+["']/gm) ?? []).map((m) => `${f}: ${m.trim()}`));
  if (b.status !== 0) fail(`browser: the installed package does not bundle: ${out(b).split("\n").slice(-2).join(" | ")}`);
  else if (staticNode.length > 0 || sourceNode.length > 0) fail(`browser: top-level ${[...staticNode, ...sourceNode].join(", ")}`);
  else ok("browser: the installed package bundles, and no installed .js imports node: at the top level");

  // 6. JSR's own npm build of the same version: the same export list (read from its tarball).
  try {
    const meta = (await (await fetch("https://npm.jsr.io/@jsr/jrmarcum__universal-wasm-loader")).json()) as {
      versions?: Record<string, { dist?: { tarball?: string } }>;
    };
    const url = meta.versions?.[version]?.dist?.tarball;
    if (url === undefined) console.log(`note JSR's npm build has no ${version} to compare (yet)`);
    else {
      const tgz = new Uint8Array(await (await fetch(url)).arrayBuffer());
      const theirs = (JSON.parse(tarFile(gunzipSync(tgz), "package/package.json")) as { exports?: Record<string, unknown> }).exports ?? {};
      const a = Object.keys(theirs).sort().join(" ");
      const ours = Object.keys(exportsMap).sort().join(" ");
      if (a !== ours) fail(`export list differs from JSR's npm build: theirs ${a} / ours ${ours}`);
      else ok(`the export list equals JSR's own npm build of ${version}`);
    }
  } catch (e) {
    console.log(`note JSR's npm build not reached: ${(e as Error).message}`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(tagRoot, { recursive: true, force: true });
}
console.log(problems.length === 0 ? `\nthe npm package holds (dist/ is ready${tag ? ` for ${tag}` : ""})` : `\n${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from '@rstest/core';
import {
  BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION,
  decideLintConfigMode,
  describeRstackConfigLoaderPreflight,
  folderRootRstackConfigPath,
  formatBridgeProtocolGate,
  formatBridgeToolchainGap,
  generatedShimPath,
  lintConfigModeSignature,
  lintIsDetected,
  removeGeneratedShim,
  renderGeneratedShim,
  resolveRstackConfigLoader,
  RSTACK_CONFIG_PROBE_ORDER,
  RstackBridgeError,
  RstackBridgeGateError,
  supportsExplicitConfigPath,
  writeGeneratedShim,
} from '../../../src/stacks/lint/rstackBridge';
import { isSupportedConfigDiscoveryProtocolVersion } from '../../../src/shared/versionCheck';

/**
 * `rstackBridge.ts` is deliberately a pure module over strings plus two
 * filesystem primitives, so the whole Ownership decision table is exercised
 * here without a `vscode` stub or an extension host.
 */

const FOLDER = path.resolve('/projects/app');
const at = (...segments: string[]): string => path.join(FOLDER, ...segments);

describe('Ownership: which config source lints a folder', () => {
  it('bridges a folder whose only config is a root rstack.config.*', () => {
    const mode = decideLintConfigMode({
      folderPath: FOLDER,
      rslintConfigPaths: [],
      rstackConfigPaths: [at('rstack.config.ts')],
    });
    expect(mode).toEqual({
      kind: 'bridged',
      rstackConfigPath: at('rstack.config.ts'),
    });
    expect(
      lintIsDetected({
        folderPath: FOLDER,
        rslintConfigPaths: [],
        rstackConfigPaths: [at('rstack.config.ts')],
      }),
    ).toBe(true);
  });

  it('yields to a native config anywhere in the folder, root or not', () => {
    // Folder-level Ownership, not directory-level: one native config in a
    // nested package puts the whole folder in native mode, with no hint and no
    // warning, because the server's config choice is fixed per folder.
    const input = {
      folderPath: FOLDER,
      rslintConfigPaths: [at('packages', 'ui', 'rslint.config.mjs')],
      rstackConfigPaths: [at('rstack.config.ts')],
    };
    expect(decideLintConfigMode(input)).toEqual({ kind: 'native' });
    expect(lintIsDetected(input)).toBe(true);
  });

  it('does not light lint for a rstack.config.* below the folder root', () => {
    const input = {
      folderPath: FOLDER,
      rslintConfigPaths: [],
      rstackConfigPaths: [at('packages', 'ui', 'rstack.config.ts')],
    };
    // A documented limitation: one language server per folder, its cwd is the
    // folder root, so a subdirectory config has no position to be pinned from.
    expect(decideLintConfigMode(input)).toEqual({ kind: 'native' });
    expect(lintIsDetected(input)).toBe(false);
  });

  it('stays in native mode when the folder has no config at all', () => {
    const input = {
      folderPath: FOLDER,
      rslintConfigPaths: [],
      rstackConfigPaths: [],
    };
    expect(decideLintConfigMode(input)).toEqual({ kind: 'native' });
    expect(lintIsDetected(input)).toBe(false);
  });

  it('picks the root config by loadRstackConfig probe order', () => {
    expect(
      folderRootRstackConfigPath(FOLDER, [
        at('rstack.config.mjs'),
        at('nested', 'rstack.config.ts'),
        at('rstack.config.js'),
        at('rstack.config.ts'),
      ]),
    ).toBe(at('rstack.config.ts'));
  });

  it('keeps the probe order glob-safe for the bridged watch pattern', () => {
    // `BRIDGED_CONFIG_REFRESH_WATCH_GLOB` folds this list into one brace group,
    // and VS Code's glob parser silently fails on a nested group — so an entry
    // carrying glob syntax would break watching without any error.
    for (const name of RSTACK_CONFIG_PROBE_ORDER) {
      expect(name).not.toMatch(/[{},*]/);
    }
  });

  it('gives each mode a distinct restart signature', () => {
    expect(lintConfigModeSignature({ kind: 'native' })).toBe('native');
    expect(
      lintConfigModeSignature({
        kind: 'bridged',
        rstackConfigPath: at('rstack.config.ts'),
      }),
    ).not.toBe(
      lintConfigModeSignature({
        kind: 'bridged',
        rstackConfigPath: at('rstack.config.js'),
      }),
    );
  });
});

describe('the capability gate', () => {
  it('refuses explicit mode below the protocol that carries configPath', () => {
    expect(supportsExplicitConfigPath(1)).toBe(false);
    expect(
      supportsExplicitConfigPath(BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION),
    ).toBe(true);
    expect(
      supportsExplicitConfigPath(
        BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION + 1,
      ),
    ).toBe(true);
  });

  it('names the package to upgrade and the version actually resolved', () => {
    const message = formatBridgeProtocolGate(1, '0.7.3');
    expect(message).toContain('@rslint/core 0.7.3');
    expect(message).toContain('upgrade @rslint/core');
    expect(message).toContain('protocol 1');
  });

  it('survives an unreadable @rslint/core version', () => {
    expect(formatBridgeProtocolGate(1, undefined)).toContain('unknown version');
  });

  it('names the transitive-dependency trap when @rslint/core is absent', () => {
    // The mainstream bridged project is an rstack-cli app on pnpm, where
    // `@rslint/core` is rstack's transitive dependency and simply not exposed.
    // "Could not resolve @rslint/core" alone reads as a broken extension.
    const message = formatBridgeToolchainGap(
      at('rstack.config.ts'),
      'Could not resolve @rslint/core from /projects/app.',
    );
    expect(message).toContain('rstack.config.ts');
    expect(message).toContain('devDependencies');
    expect(message).toContain('pnpm');
  });

  it('separates a refusal from a crash', () => {
    // `Rslint.reportStartFailure` and the coordinator's expected-failure
    // predicate both branch on exactly this class — one type for both gates,
    // because that is the whole granularity anything consumes.
    expect(new RstackBridgeGateError('gate')).toBeInstanceOf(Error);
    // A plain bridge failure is *not* a gate: it stays a crash.
    expect(new RstackBridgeError('broken')).not.toBeInstanceOf(
      RstackBridgeGateError,
    );
  });

  it('asks for a protocol the copied client itself supports', () => {
    // The two constants live on opposite sides of the port: the bridge names
    // the protocol it needs, `shared/versionCheck.ts` names what this client
    // speaks. Raising the bridge floor past that set would gate every bridged
    // folder on a protocol the client would then reject anyway.
    expect(
      isSupportedConfigDiscoveryProtocolVersion(
        BRIDGE_MIN_CONFIG_DISCOVERY_PROTOCOL_VERSION,
      ),
    ).toBe(true);
  });
});

describe('the generated shim', () => {
  const loaderPath = at('node_modules', 'rstack', 'dist', 'configExports.js');
  const configPath = at('rstack.config.ts');

  it('bakes both absolute paths in and mirrors rstack shipped shim', () => {
    const source = renderGeneratedShim({
      configLoaderPath: loaderPath,
      rstackConfigPath: configPath,
    });
    expect(source).toContain(JSON.stringify(pathToFileURL(loaderPath).href));
    expect(source).toContain(JSON.stringify(configPath));
    // The shim body is the mirror of `<rstack>/dist/rslintConfig.js`: take
    // `configs.lint ?? []`, await the function form, default-export it.
    expect(source).toContain('configs.lint ?? []');
    expect(source).toContain('await lintExports()');
    expect(source).toContain('export default');
    // Never the no-argument call: it probes the evaluation cwd, which in the
    // extension host is meaningless.
    expect(source).not.toContain('loadRstackConfig()');
  });

  it('escapes Windows paths in both baked-in positions', () => {
    const source = renderGeneratedShim({
      configLoaderPath: 'C:\\Users\\dev\\app\\node_modules\\rstack\\dist\\c.js',
      rstackConfigPath: 'C:\\Users\\dev\\app\\rstack.config.ts',
    });
    // In the one position where a raw backslash run *would* be an escape
    // sequence — the string literal — every separator is doubled.
    expect(source).toContain(
      'configFilePath: "C:\\\\Users\\\\dev\\\\app\\\\rstack.config.ts"',
    );
    // The loader is embedded as a `file:` URL, which never carries a raw
    // backslash: on Windows `pathToFileURL` turns separators into `/`, and
    // anything left over is percent-encoded. (The rendering runs on the host
    // that owns the path, so the POSIX result of this very case is only
    // interesting for that invariant.)
    const importLine = source
      .split('\n')
      .find((line) => line.startsWith('import '));
    expect(importLine).toBeDefined();
    expect(importLine).toContain('file:');
    expect(importLine).not.toContain('\\');
  });
});

describe('writing the generated shim', () => {
  const roots: string[] = [];
  const makeFolder = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstack-bridge-'));
    roots.push(root);
    return root;
  };

  afterAll(() => {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes into the project so resolution anchors there', () => {
    const folder = makeFolder();
    const input = {
      folderPath: folder,
      configLoaderPath: path.join(folder, 'node_modules/rstack/dist/c.js'),
      rstackConfigPath: path.join(folder, 'rstack.config.ts'),
    };
    const result = writeGeneratedShim(input);
    expect(result.written).toBe(true);
    expect(result.path).toBe(generatedShimPath(folder));
    expect(path.relative(folder, result.path).split(path.sep)).toEqual([
      'node_modules',
      '.cache',
      'rstack-editor',
      'rslint.config.mjs',
    ]);
    // What landed on disk is exactly what the renderer produces — the writer
    // adds nothing of its own.
    expect(fs.readFileSync(result.path, 'utf8')).toBe(
      renderGeneratedShim(input),
    );
  });

  it('does not rewrite an already identical shim', () => {
    const folder = makeFolder();
    const input = {
      folderPath: folder,
      configLoaderPath: path.join(folder, 'node_modules/rstack/dist/c.js'),
      rstackConfigPath: path.join(folder, 'rstack.config.ts'),
    };
    const first = writeGeneratedShim(input);
    const stat = fs.statSync(first.path);
    const second = writeGeneratedShim(input);
    // No churn: every rewrite is a config mutation the watcher would observe.
    expect(second.written).toBe(false);
    expect(fs.statSync(second.path).mtimeMs).toBe(stat.mtimeMs);
  });

  it('removes a shim left behind when the folder flips to native mode', () => {
    const folder = makeFolder();
    const written = writeGeneratedShim({
      folderPath: folder,
      configLoaderPath: path.join(folder, 'node_modules/rstack/dist/c.js'),
      rstackConfigPath: path.join(folder, 'rstack.config.ts'),
    });
    expect(removeGeneratedShim(folder)).toBe(true);
    expect(fs.existsSync(written.path)).toBe(false);
    // Idempotent: a folder that was never bridged is the common case.
    expect(removeGeneratedShim(folder)).toBe(false);
  });

  it('rewrites when the baked-in config path changes', () => {
    const folder = makeFolder();
    const base = {
      folderPath: folder,
      configLoaderPath: path.join(folder, 'node_modules/rstack/dist/c.js'),
    };
    writeGeneratedShim({
      ...base,
      rstackConfigPath: path.join(folder, 'rstack.config.ts'),
    });
    const second = writeGeneratedShim({
      ...base,
      rstackConfigPath: path.join(folder, 'rstack.config.mjs'),
    });
    expect(second.written).toBe(true);
    expect(fs.readFileSync(second.path, 'utf8')).toContain('rstack.config.mjs');
  });
});

describe('resolving the project rstack config loader', () => {
  const roots: string[] = [];
  const makeProject = (
    packageJson: unknown,
    { withEntry = true }: { withEntry?: boolean } = {},
  ): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstack-resolve-'));
    roots.push(root);
    const packageDir = path.join(root, 'node_modules', 'rstack');
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify(packageJson),
    );
    if (withEntry) {
      fs.writeFileSync(
        path.join(packageDir, 'dist', 'configExports.js'),
        'export const loadRstackConfig = () => {};',
      );
    }
    return root;
  };

  afterAll(() => {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the ./config target out of the exports map', () => {
    const root = makeProject({
      name: 'rstack',
      exports: {
        './config': {
          types: './dist/configExports.d.ts',
          default: './dist/configExports.js',
        },
      },
    });
    expect(resolveRstackConfigLoader(root)).toBe(
      fs.realpathSync(
        path.join(root, 'node_modules/rstack/dist/configExports.js'),
      ),
    );
  });

  it('takes the ESM branch of a split entry, never the CommonJS default', () => {
    // The shim is `.mjs` and imports the target by `file:` URL, so `import`
    // beats `default` — a fixed preference list ending in `default` would grab
    // the CommonJS build the moment `rstack` splits the entry.
    const root = makeProject({
      name: 'rstack',
      exports: {
        './config': {
          types: './dist/configExports.d.ts',
          import: './dist/configExports.js',
          require: './dist/configExports.cjs',
          default: './dist/configExports.cjs',
        },
      },
    });
    expect(resolveRstackConfigLoader(root)).toBe(
      fs.realpathSync(
        path.join(root, 'node_modules/rstack/dist/configExports.js'),
      ),
    );
  });

  it('descends into a nested condition map', () => {
    // The runtime-then-format shape: a `node` branch that itself splits into
    // `import`/`require`. Reading only the top level would fall through to
    // `default` and hand the shim a CommonJS build.
    const root = makeProject({
      name: 'rstack',
      exports: {
        './config': {
          types: './dist/configExports.d.ts',
          node: {
            require: './dist/configExports.cjs',
            import: './dist/configExports.js',
          },
          default: './dist/configExports.cjs',
        },
      },
    });
    expect(resolveRstackConfigLoader(root)).toBe(
      fs.realpathSync(
        path.join(root, 'node_modules/rstack/dist/configExports.js'),
      ),
    );
  });

  it('asks for an upgrade when rstack publishes no ./config', () => {
    const root = makeProject({
      name: 'rstack',
      exports: { '.': './dist/index.js' },
    });
    // A package-version prerequisite is a gate (`version mismatch`), never a
    // crash: the remedy is an upgrade, and the status detail is where it goes.
    expect(() => resolveRstackConfigLoader(root)).toThrow(
      RstackBridgeGateError,
    );
    expect(() => resolveRstackConfigLoader(root)).toThrow(/0\.4\.0/);
  });

  it('reports an unrecognised ./config shape without asking for an upgrade', () => {
    // The entry is there, so the install is not old — telling the user to
    // upgrade would send them somewhere that cannot help. Not a gate either:
    // this is a broken install shape, not a version prerequisite.
    const root = makeProject({
      name: 'rstack',
      exports: { './config': { types: './dist/configExports.d.ts' } },
    });
    expect(() => resolveRstackConfigLoader(root)).toThrow(RstackBridgeError);
    expect(() => resolveRstackConfigLoader(root)).not.toThrow(
      RstackBridgeGateError,
    );
    expect(() => resolveRstackConfigLoader(root)).toThrow(
      /no target an ESM import can take/,
    );
    expect(() => resolveRstackConfigLoader(root)).not.toThrow(/0\.4\.0/);
  });

  it('reports an unreadable manifest as a broken install, not a gate', () => {
    // A manifest that cannot be parsed means a broken install, not an old
    // one — "upgrade rstack" would mislead, so it must not join the
    // no-./config prerequisite in the gate.
    const root = makeProject({ name: 'rstack' });
    fs.writeFileSync(
      path.join(root, 'node_modules', 'rstack', 'package.json'),
      'not json',
    );
    expect(() => resolveRstackConfigLoader(root)).toThrow(RstackBridgeError);
    expect(() => resolveRstackConfigLoader(root)).not.toThrow(
      RstackBridgeGateError,
    );
    expect(() => resolveRstackConfigLoader(root)).toThrow(
      /Could not read the installed "rstack" manifest/,
    );
    expect(() => resolveRstackConfigLoader(root)).not.toThrow(/0\.4\.0/);
  });

  it('reports a missing rstack install instead of guessing a path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rstack-empty-'));
    roots.push(root);
    expect(() => resolveRstackConfigLoader(root)).toThrow(
      /Could not resolve the "rstack" package/,
    );
    // Missing package = install prerequisite = gate, like the toolchain gap.
    expect(() => resolveRstackConfigLoader(root)).toThrow(
      RstackBridgeGateError,
    );
  });
});

describe('the rstack-loader preflight', () => {
  it('warns only for a TypeScript config on a host without type stripping', () => {
    expect(
      describeRstackConfigLoaderPreflight({
        rstackConfigPath: at('rstack.config.ts'),
        nativeTypeStripping: false,
      }),
    ).toMatch(/rstack\.config\.ts/);
    expect(
      describeRstackConfigLoaderPreflight({
        rstackConfigPath: at('rstack.config.ts'),
        nativeTypeStripping: true,
      }),
    ).toBeUndefined();
    expect(
      describeRstackConfigLoaderPreflight({
        rstackConfigPath: at('rstack.config.mjs'),
        nativeTypeStripping: false,
      }),
    ).toBeUndefined();
  });
});

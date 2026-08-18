import fs from 'node:fs';
import path from 'node:path';
import type { ConfigModuleActivationPlan } from '@rslint/core/config-loader';

const LOCKFILE_NAMES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
] as const;

export class ActivationFingerprinter {
  private dependencyRevision = 0;

  constructor(private readonly cwd: string) {}

  observeRefresh(reason: unknown): void {
    if (reason === 'dependency-change') this.dependencyRevision++;
  }

  compute(activation: ConfigModuleActivationPlan): string {
    const sourceFingerprintByPath = new Map(
      activation.configs.map((config) => [
        path.normalize(config.configPath),
        config.sourceFingerprint,
      ]),
    );
    const parts: string[] = [];
    const configPaths = activation.pluginConfigs
      .map((config) => config.configPath)
      .sort();
    for (const configPath of configPaths) {
      const sourceFingerprint = sourceFingerprintByPath.get(
        path.normalize(configPath),
      );
      if (sourceFingerprint === undefined) {
        throw new Error(
          `missing source fingerprint for plugin config ${configPath}`,
        );
      }
      parts.push(`${configPath}:${sourceFingerprint}`);
    }
    for (const name of LOCKFILE_NAMES) {
      parts.push(
        `lock:${name}:${this.computeMetadataFingerprint(path.join(this.cwd, name))}`,
      );
    }
    parts.push(`dependency-revision:${this.dependencyRevision}`);
    return parts.join('|');
  }

  private computeMetadataFingerprint(filePath: string): string {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return 'absent';
    }
  }
}

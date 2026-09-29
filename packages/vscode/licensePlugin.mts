import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RsbuildPlugin } from '@rsbuild/core';
import WebpackLicensePlugin from 'webpack-license-plugin';

type PackageLicense = {
  name: string;
  version: string;
  license?: string;
  licenseText?: string;
  repository?: string;
};

// Yuku's npm packages omit LICENSE. Copied from the upstream MIT notice:
// https://github.com/yuku-toolchain/yuku/blob/main/LICENSE
const yukuLicenseText = `MIT License

Copyright (c) 2026 Yuku

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export function licensePlugin(
  packageRoot: string,
  yukuBindingName: string,
): RsbuildPlugin {
  const packages = new Map<string, PackageLicense>();
  return {
    name: 'rstack-third-party-licenses',
    setup(api) {
      api.modifyRspackConfig((config, { environment }) => {
        // Separate inventories prevent concurrent lib compilations from
        // overwriting each other. Only the merged Markdown ships in the VSIX.
        const filename = `.licenses/${environment.name}.json`;
        config.plugins ??= [];
        config.plugins.push(
          new WebpackLicensePlugin({
            outputFilename: filename,
            additionalFiles: {
              [filename]: (inventory) => {
                for (const pkg of inventory)
                  packages.set(`${pkg.name}@${pkg.version}`, pkg);
                return JSON.stringify(inventory, null, 2);
              },
            },
          }),
        );
      });
      api.onAfterBuild(({ stats }) => {
        if (stats?.hasErrors()) return;
        const notices = [...packages.values()].filter(
          ({ name }) => name !== 'yuku-parser',
        );
        for (const name of ['yuku-parser', yukuBindingName]) {
          notices.push({
            name,
            version: '',
            license: 'MIT',
            repository: 'https://github.com/yuku-toolchain/yuku',
            licenseText: yukuLicenseText,
          });
        }
        const body = notices
          .sort(
            (a, b) =>
              a.name.localeCompare(b.name) ||
              a.version.localeCompare(b.version),
          )
          .map((pkg) => {
            const text = pkg.licenseText;
            if (!text) throw new Error(`Missing license text for ${pkg.name}`);
            return `### ${pkg.name}${pkg.version ? ` (${pkg.version})` : ''}\n\nLicensed under ${pkg.license} license${pkg.repository ? ` in the repository at ${pkg.repository}` : ''}.\n\n${text
              .trim()
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n')}`;
          })
          .join('\n\n');
        const header = readFileSync(
          path.resolve(packageRoot, '../../LICENSE'),
          'utf8',
        ).trimEnd();
        writeFileSync(
          path.join(packageRoot, 'LICENSE.md'),
          `${header}\n\n## Third-party licenses\n\nThe following third-party packages are bundled into the Rstack VS Code extension.\n\n${body}\n`,
        );
      });
    },
  };
}

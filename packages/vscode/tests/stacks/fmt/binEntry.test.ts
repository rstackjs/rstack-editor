import { describe, expect, it } from '@rstest/core';
import { pickBinEntry } from '../../../src/stacks/fmt/binEntry';

/**
 * The `rs` entry the fmt language server is spawned with comes out of the
 * resolved `rstack` package.json, whose `bin` field npm allows in two shapes. A
 * wrong pick spawns nothing at all, and the failure would reach the user as a
 * language server that never starts.
 */
describe('pickBinEntry', () => {
  it('takes the string form as the entry', () => {
    expect(pickBinEntry('dist/cli.js')).toBe('dist/cli.js');
  });

  it('takes the `rs` key out of the object form', () => {
    expect(pickBinEntry({ rs: 'bin/rs.mjs', rstack: 'bin/other.js' })).toBe(
      'bin/rs.mjs',
    );
  });

  it('falls back to the documented default when the field is unusable', () => {
    expect(pickBinEntry(undefined)).toBe('bin/rs.js');
    expect(pickBinEntry(null)).toBe('bin/rs.js');
    expect(pickBinEntry({})).toBe('bin/rs.js');
    expect(pickBinEntry({ rstack: 'bin/rs.js' })).toBe('bin/rs.js');
    expect(pickBinEntry({ rs: 42 })).toBe('bin/rs.js');
  });
});

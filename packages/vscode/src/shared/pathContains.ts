import path from 'node:path';

export const relativeIsContained = (relative: string): boolean =>
  relative === '' ||
  (relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));

/** True when `file` is inside `dir` (or is `dir` itself). */
export const contains = (dir: string, file: string): boolean =>
  relativeIsContained(path.relative(path.resolve(dir), path.resolve(file)));

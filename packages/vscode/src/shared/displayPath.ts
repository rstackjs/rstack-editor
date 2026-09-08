import path from 'node:path';

/** A folder-relative status label, without exposing paths outside the folder. */
export const displayPath = (folderPath: string, filePath: string): string => {
  const relative = path.relative(folderPath, filePath);
  return relative.length > 0 && !relative.startsWith('..')
    ? relative
    : path.basename(filePath);
};

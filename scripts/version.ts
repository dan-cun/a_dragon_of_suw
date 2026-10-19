import { z } from 'zod';

export const releaseVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/);

export function windowsVersion(version: string): string {
  const release = releaseVersionSchema.parse(version);
  const components = release.split('-')[0]!.split('.').map(Number);
  if (components.some(value => !Number.isInteger(value) || value > 65535)) throw new Error('Windows version components must be integers between 0 and 65535.');
  return [...components, 0].join('.');
}

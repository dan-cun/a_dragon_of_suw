import { z } from 'zod';
import packageMetadata from '../../package.json' with { type: 'json' };

export const releaseEditionSchema = z.enum(['academic', 'basic']);
export const releaseEdition = releaseEditionSchema.parse(packageMetadata.edition);
export const editionLabel = releaseEdition === 'academic' ? '含教务版' : '基础版';

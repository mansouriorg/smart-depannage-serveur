import { BadRequestException } from '@nestjs/common';
import { memoryStorage } from 'multer';

import { PROOF_MAX_MB } from '../files/files.service';

/** The types the phone may declare; the bytes are checked by the files module afterwards. */
export const PROOF_DECLARED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

/**
 * How a proof photo is received (P1-07): in memory, never in a folder the web server could serve,
 * one file, the size capped, and the declared type checked before anything is read. The folder is
 * chosen by the files module after the proof service has judged the photo.
 */
export const PROOF_UPLOAD = {
  storage: memoryStorage(),
  // The form is a photo and a handful of short values: nothing else is read into memory.
  limits: { fileSize: PROOF_MAX_MB * 1024 * 1024, files: 1, fields: 12, fieldSize: 1024, parts: 16, headerPairs: 50 },
  fileFilter: (_req: unknown, file: { mimetype: string }, cb: (error: Error | null, accept: boolean) => void) => {
    if (PROOF_DECLARED_TYPES.includes(String(file.mimetype).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new BadRequestException('La preuve doit être une photo (JPEG, PNG ou WebP).'), false);
    }
  },
};

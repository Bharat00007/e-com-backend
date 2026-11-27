import path from 'path';
import fs from 'fs';
import { env } from '../config/env';
import { BadRequestError } from '../utils/errors';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface UploadedImageResult {
  url: string;
  provider: string;
  sizeBytes: number;
  mimeType: string;
}

export function validateImageUpload(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw new BadRequestError('No image file provided');
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new BadRequestError('Unsupported image type. Allowed: JPEG, PNG, WEBP');
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new BadRequestError('Image exceeds maximum allowed size of 5 MB');
  }
  return file;
}

export async function storeProductImage(file: Express.Multer.File): Promise<UploadedImageResult> {
  validateImageUpload(file);

  if (env.STORAGE_PROVIDER === 'local') {
    const uploadsDir = path.resolve(process.cwd(), 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    const safeName = `${Date.now()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const dest = path.join(uploadsDir, safeName);
    fs.writeFileSync(dest, file.buffer);
    return {
      url: `/uploads/${safeName}`,
      provider: 'local',
      sizeBytes: file.size,
      mimeType: file.mimetype,
    };
  }

  if (env.STORAGE_PROVIDER === 's3') {
    if (
      !env.S3_ENDPOINT ||
      !env.S3_BUCKET ||
      !env.S3_ACCESS_KEY_ID ||
      env.S3_ACCESS_KEY_ID.startsWith('your_')
    ) {
      throw new BadRequestError(
        'Cloudflare R2 / S3 credentials (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) are not configured in backend/.env.'
      );
    }
    const safeName = `${Date.now()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    return {
      url: `${env.S3_ENDPOINT.replace(/\/$/, '')}/${env.S3_BUCKET}/${safeName}`,
      provider: 'cloudflare-r2',
      sizeBytes: file.size,
      mimeType: file.mimetype,
    };
  }

  throw new BadRequestError(
    `Cloud storage provider "${env.STORAGE_PROVIDER}" requires credentials in backend/.env.`
  );
}

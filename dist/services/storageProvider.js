"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateImageUpload = validateImageUpload;
exports.storeProductImage = storeProductImage;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const env_1 = require("../config/env");
const errors_1 = require("../utils/errors");
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
function validateImageUpload(file) {
    if (!file)
        throw new errors_1.BadRequestError('No image file provided');
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        throw new errors_1.BadRequestError('Unsupported image type. Allowed: JPEG, PNG, WEBP');
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
        throw new errors_1.BadRequestError('Image exceeds maximum allowed size of 5 MB');
    }
    return file;
}
async function storeProductImage(file) {
    validateImageUpload(file);
    if (env_1.env.STORAGE_PROVIDER === 'local') {
        const uploadsDir = path_1.default.resolve(process.cwd(), 'uploads');
        fs_1.default.mkdirSync(uploadsDir, { recursive: true });
        const safeName = `${Date.now()}-${path_1.default.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const dest = path_1.default.join(uploadsDir, safeName);
        fs_1.default.writeFileSync(dest, file.buffer);
        return {
            url: `/uploads/${safeName}`,
            provider: 'local',
            sizeBytes: file.size,
            mimeType: file.mimetype,
        };
    }
    if (env_1.env.STORAGE_PROVIDER === 's3') {
        if (!env_1.env.S3_ENDPOINT ||
            !env_1.env.S3_BUCKET ||
            !env_1.env.S3_ACCESS_KEY_ID ||
            env_1.env.S3_ACCESS_KEY_ID.startsWith('your_')) {
            throw new errors_1.BadRequestError('Cloudflare R2 / S3 credentials (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY) are not configured in backend/.env.');
        }
        const safeName = `${Date.now()}-${path_1.default.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        return {
            url: `${env_1.env.S3_ENDPOINT.replace(/\/$/, '')}/${env_1.env.S3_BUCKET}/${safeName}`,
            provider: 'cloudflare-r2',
            sizeBytes: file.size,
            mimeType: file.mimetype,
        };
    }
    throw new errors_1.BadRequestError(`Cloud storage provider "${env_1.env.STORAGE_PROVIDER}" requires credentials in backend/.env.`);
}

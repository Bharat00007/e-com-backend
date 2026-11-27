"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
dotenv_1.default.config();
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(['development', 'test', 'production']).default('development'),
    PORT: zod_1.z.coerce.number().int().positive().default(4000),
    FRONTEND_URL: zod_1.z.string().default('http://localhost:5173'),
    DATABASE_URL: zod_1.z
        .string()
        .default('postgresql://postgres:postgres@localhost:5432/the_sniff_co?schema=public'),
    JWT_ACCESS_SECRET: zod_1.z.string().min(16).default('dev_access_secret_change_in_production_32ch'),
    JWT_REFRESH_SECRET: zod_1.z.string().min(16).default('dev_refresh_secret_change_in_production_32ch'),
    JWT_ACCESS_EXPIRES_IN: zod_1.z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: zod_1.z.string().default('7d'),
    COOKIE_DOMAIN: zod_1.z.string().optional(),
    COOKIE_SAME_SITE: zod_1.z.enum(['lax', 'strict', 'none']).optional(),
    SEED_DEMO_CUSTOMER: zod_1.z.enum(['true', 'false']).default('false'),
    RAZORPAY_KEY_ID: zod_1.z.string().default(''),
    RAZORPAY_KEY_SECRET: zod_1.z.string().default(''),
    RAZORPAY_WEBHOOK_SECRET: zod_1.z.string().default(''),
    STORAGE_PROVIDER: zod_1.z.enum(['local', 'cloudinary', 's3']).default('local'),
    CLOUDINARY_CLOUD_NAME: zod_1.z.string().default(''),
    CLOUDINARY_API_KEY: zod_1.z.string().default(''),
    CLOUDINARY_API_SECRET: zod_1.z.string().default(''),
    S3_ENDPOINT: zod_1.z.string().default(''),
    S3_BUCKET: zod_1.z.string().default(''),
    S3_REGION: zod_1.z.string().default('auto'),
    S3_ACCESS_KEY_ID: zod_1.z.string().default(''),
    S3_SECRET_ACCESS_KEY: zod_1.z.string().default(''),
    SHIPPING_PROVIDER: zod_1.z.enum(['modular', 'shiprocket']).default('modular'),
    SHIPROCKET_EMAIL: zod_1.z.string().default(''),
    SHIPROCKET_PASSWORD: zod_1.z.string().default(''),
    OTP_MODE: zod_1.z.enum(['development', 'production']).default('development'),
    ENABLE_TEST_OTP: zod_1.z
        .string()
        .optional()
        .transform((v) => v === 'true' || v === undefined)
        .default('true'),
    SMTP_HOST: zod_1.z.string().default(''),
    SMTP_PORT: zod_1.z.coerce.number().int().positive().default(587),
    SMTP_SECURE: zod_1.z
        .string()
        .optional()
        .transform((v) => v === 'true'),
    SMTP_USER: zod_1.z.string().default(''),
    SMTP_PASS: zod_1.z.string().default(''),
    SMTP_FROM_NAME: zod_1.z.string().default('The Sniff Co.'),
    SMTP_FROM_EMAIL: zod_1.z.string().default(''),
});
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
}
if (parsed.data.NODE_ENV === 'production' &&
    (parsed.data.JWT_ACCESS_SECRET.startsWith('dev_') ||
        parsed.data.JWT_REFRESH_SECRET.startsWith('dev_'))) {
    console.error('Refusing to start in production with default development JWT secrets. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET.');
    process.exit(1);
}
if (parsed.data.NODE_ENV === 'production' &&
    (parsed.data.OTP_MODE === 'development' || parsed.data.ENABLE_TEST_OTP === true)) {
    console.error('CRITICAL SECURITY ERROR: Refusing to start in production with development OTP mode enabled (OTP_MODE=development or ENABLE_TEST_OTP=true). Set OTP_MODE=production and disable test OTP.');
    process.exit(1);
}
exports.env = parsed.data;

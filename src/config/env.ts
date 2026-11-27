import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  DATABASE_URL: z
    .string()
    .default('postgresql://postgres:postgres@localhost:5432/the_sniff_co?schema=public'),
  JWT_ACCESS_SECRET: z.string().min(16).default('dev_access_secret_change_in_production_32ch'),
  JWT_REFRESH_SECRET: z.string().min(16).default('dev_refresh_secret_change_in_production_32ch'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).optional(),
  SEED_DEMO_CUSTOMER: z.enum(['true', 'false']).default('false'),
  RAZORPAY_KEY_ID: z.string().default(''),
  RAZORPAY_KEY_SECRET: z.string().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().default(''),
  STORAGE_PROVIDER: z.enum(['local', 'cloudinary', 's3']).default('local'),
  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().default(''),
  S3_SECRET_ACCESS_KEY: z.string().default(''),
  SHIPPING_PROVIDER: z.enum(['modular', 'shiprocket']).default('modular'),
  SHIPROCKET_EMAIL: z.string().default(''),
  SHIPROCKET_PASSWORD: z.string().default(''),
  OTP_MODE: z.enum(['development', 'production']).default('development'),
  ENABLE_TEST_OTP: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === undefined)
    .default('true'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM_NAME: z.string().default('The Sniff Co.'),
  SMTP_FROM_EMAIL: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

if (
  parsed.data.NODE_ENV === 'production' &&
  (parsed.data.JWT_ACCESS_SECRET.startsWith('dev_') ||
    parsed.data.JWT_REFRESH_SECRET.startsWith('dev_'))
) {
  console.error(
    'Refusing to start in production with default development JWT secrets. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET.'
  );
  process.exit(1);
}

if (
  parsed.data.NODE_ENV === 'production' &&
  (parsed.data.OTP_MODE === 'development' || parsed.data.ENABLE_TEST_OTP === true)
) {
  console.error(
    'CRITICAL SECURITY ERROR: Refusing to start in production with development OTP mode enabled (OTP_MODE=development or ENABLE_TEST_OTP=true). Set OTP_MODE=production and disable test OTP.'
  );
  process.exit(1);
}

export const env = parsed.data;

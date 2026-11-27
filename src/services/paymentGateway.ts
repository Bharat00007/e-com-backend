import crypto from 'crypto';
import { env } from '../config/env';
import { AppError } from '../utils/errors';

export interface GatewayOrderResult {
  provider: 'razorpay';
  gatewayOrderId: string;
  amountPaise: number;
  currency: 'INR';
  keyId: string;
  isConfigured: boolean;
}

export function isRazorpayConfigured(): boolean {
  return Boolean(
    env.RAZORPAY_KEY_ID &&
      env.RAZORPAY_KEY_SECRET &&
      !env.RAZORPAY_KEY_ID.includes('placeholder') &&
      !env.RAZORPAY_KEY_SECRET.includes('replace_with')
  );
}

export function getPaymentConfigurationStatus() {
  const available = isRazorpayConfigured();
  return {
    onlinePaymentsAvailable: available,
    provider: 'razorpay' as const,
    message: available
      ? 'Online payment is configured and ready.'
      : 'Online payment is not configured yet.',
  };
}

export async function createRazorpayOrder(
  orderNumber: string,
  amountInr: number
): Promise<GatewayOrderResult> {
  const amountPaise = Math.round(amountInr * 100);

  if (!isRazorpayConfigured()) {
    throw new AppError(
      'Razorpay merchant credentials are not configured in backend/.env. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET for test or live mode.',
      503,
      'PAYMENT_GATEWAY_NOT_CONFIGURED'
    );
  }

  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      receipt: orderNumber,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new AppError(`Razorpay order creation failed: ${errText}`, 502, 'PAYMENT_GATEWAY_ERROR');
  }

  const data = (await response.json()) as { id: string; amount: number };
  return {
    provider: 'razorpay',
    gatewayOrderId: data.id,
    amountPaise: data.amount,
    currency: 'INR',
    keyId: env.RAZORPAY_KEY_ID,
    isConfigured: true,
  };
}

export function verifyRazorpaySignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  razorpaySignature: string,
  secretOverride?: string
): boolean {
  const secret = secretOverride ?? env.RAZORPAY_KEY_SECRET;
  if (!secret || secret.includes('replace_with')) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpaySignature));
}

export function verifyRazorpayWebhookSignature(
  rawBody: string | Buffer,
  webhookSignature: string,
  secretOverride?: string
): boolean {
  const secret = secretOverride ?? env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || secret.includes('replace_with')) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(webhookSignature));
  } catch {
    return false;
  }
}

import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import {
  getPaymentConfigurationStatus,
  verifyRazorpaySignature,
  verifyRazorpayWebhookSignature,
} from '../src/services/paymentGateway';
import {
  checkPincodeServiceability,
  validateIndianPincode,
} from '../src/services/shippingProvider';

describe('paymentGateway & shippingProvider', () => {
  it('reports onlinePaymentsAvailable=false when Razorpay credentials are not set', () => {
    const status = getPaymentConfigurationStatus();
    expect(status.provider).toBe('razorpay');
    expect(status.onlinePaymentsAvailable).toBe(false);
  });

  it('verifies a valid Razorpay payment signature', () => {
    const secret = 'test_secret_123';
    const orderId = 'order_Test123';
    const paymentId = 'pay_Test456';
    const sig = crypto
      .createHmac('sha256', secret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    expect(verifyRazorpaySignature(orderId, paymentId, sig, secret)).toBe(true);
    expect(verifyRazorpaySignature(orderId, paymentId, '0'.repeat(sig.length), secret)).toBe(false);
  });

  it('verifies a valid Razorpay webhook signature', () => {
    const secret = 'webhook_secret_123';
    const payload = JSON.stringify({ event: 'payment.captured' });
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    expect(verifyRazorpayWebhookSignature(payload, sig, secret)).toBe(true);
    expect(verifyRazorpayWebhookSignature(payload, 'invalid', secret)).toBe(false);
  });

  it('validates Indian 6-digit PIN codes and serviceability', async () => {
    expect(validateIndianPincode('411001')).toBe(true);
    expect(validateIndianPincode('011001')).toBe(false);
    expect(validateIndianPincode('4110')).toBe(false);

    const metro = await checkPincodeServiceability('560038');
    expect(metro.serviceable).toBe(true);
    expect(metro.codAvailable).toBe(true);
    expect(metro.estimatedDays).toBe('1–2 business days');

    const invalid = await checkPincodeServiceability('000000');
    expect(invalid.serviceable).toBe(false);
  });
});

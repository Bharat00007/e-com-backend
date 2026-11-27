"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRazorpayConfigured = isRazorpayConfigured;
exports.getPaymentConfigurationStatus = getPaymentConfigurationStatus;
exports.createRazorpayOrder = createRazorpayOrder;
exports.verifyRazorpaySignature = verifyRazorpaySignature;
exports.verifyRazorpayWebhookSignature = verifyRazorpayWebhookSignature;
const crypto_1 = __importDefault(require("crypto"));
const env_1 = require("../config/env");
const errors_1 = require("../utils/errors");
function isRazorpayConfigured() {
    return Boolean(env_1.env.RAZORPAY_KEY_ID &&
        env_1.env.RAZORPAY_KEY_SECRET &&
        !env_1.env.RAZORPAY_KEY_ID.includes('placeholder') &&
        !env_1.env.RAZORPAY_KEY_SECRET.includes('replace_with'));
}
function getPaymentConfigurationStatus() {
    const available = isRazorpayConfigured();
    return {
        onlinePaymentsAvailable: available,
        provider: 'razorpay',
        message: available
            ? 'Online payment is configured and ready.'
            : 'Online payment is not configured yet.',
    };
}
async function createRazorpayOrder(orderNumber, amountInr) {
    const amountPaise = Math.round(amountInr * 100);
    if (!isRazorpayConfigured()) {
        throw new errors_1.AppError('Razorpay merchant credentials are not configured in backend/.env. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET for test or live mode.', 503, 'PAYMENT_GATEWAY_NOT_CONFIGURED');
    }
    const auth = Buffer.from(`${env_1.env.RAZORPAY_KEY_ID}:${env_1.env.RAZORPAY_KEY_SECRET}`).toString('base64');
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
        throw new errors_1.AppError(`Razorpay order creation failed: ${errText}`, 502, 'PAYMENT_GATEWAY_ERROR');
    }
    const data = (await response.json());
    return {
        provider: 'razorpay',
        gatewayOrderId: data.id,
        amountPaise: data.amount,
        currency: 'INR',
        keyId: env_1.env.RAZORPAY_KEY_ID,
        isConfigured: true,
    };
}
function verifyRazorpaySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature, secretOverride) {
    const secret = secretOverride ?? env_1.env.RAZORPAY_KEY_SECRET;
    if (!secret || secret.includes('replace_with'))
        return false;
    const expected = crypto_1.default
        .createHmac('sha256', secret)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');
    return crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpaySignature));
}
function verifyRazorpayWebhookSignature(rawBody, webhookSignature, secretOverride) {
    const secret = secretOverride ?? env_1.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || secret.includes('replace_with'))
        return false;
    const expected = crypto_1.default.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(expected), Buffer.from(webhookSignature));
    }
    catch {
        return false;
    }
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSmtpConfigured = isSmtpConfigured;
exports.getEmailConfigurationStatus = getEmailConfigurationStatus;
exports.createSmtpTransporter = createSmtpTransporter;
exports.verifySmtpConnection = verifySmtpConnection;
exports.sendOtpVerificationEmail = sendOtpVerificationEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
const env_1 = require("../config/env");
const errors_1 = require("../utils/errors");
const otp_1 = require("../utils/otp");
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function isSmtpConfigured() {
    const host = env_1.env.SMTP_HOST.trim();
    const user = env_1.env.SMTP_USER.trim();
    const pass = env_1.env.SMTP_PASS.trim();
    const fromEmail = env_1.env.SMTP_FROM_EMAIL.trim();
    if (!host || !user || !pass || !fromEmail)
        return false;
    if (host === 'smtp.example.com')
        return false;
    if (pass.startsWith('replace_with_') || pass.startsWith('your_'))
        return false;
    return true;
}
function getEmailConfigurationStatus() {
    return {
        configured: isSmtpConfigured(),
        host: env_1.env.SMTP_HOST ? env_1.env.SMTP_HOST : null,
        port: env_1.env.SMTP_PORT,
        secure: env_1.env.SMTP_SECURE,
    };
}
function createSmtpTransporter() {
    return nodemailer_1.default.createTransport({
        host: env_1.env.SMTP_HOST,
        port: env_1.env.SMTP_PORT,
        secure: env_1.env.SMTP_SECURE,
        auth: {
            user: env_1.env.SMTP_USER,
            pass: env_1.env.SMTP_PASS,
        },
    });
}
async function verifySmtpConnection() {
    if (!isSmtpConfigured()) {
        return { ok: false, error: 'SMTP credentials are not configured.' };
    }
    try {
        const transporter = createSmtpTransporter();
        await transporter.verify();
        return { ok: true };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : 'SMTP verification failed',
        };
    }
}
async function sendOtpVerificationEmail({ toEmail, fullName, otp, expiresInMinutes = 5, }) {
    if (!isSmtpConfigured()) {
        throw new errors_1.AppError('Email verification service (SMTP) is not configured yet. Please configure SMTP settings in backend/.env.', 503, 'EMAIL_SERVICE_NOT_CONFIGURED');
    }
    const safeName = escapeHtml(fullName.trim() || 'Pet Parent');
    const fromName = env_1.env.SMTP_FROM_NAME.trim() || 'The Sniff Co.';
    const fromAddress = `"${fromName.replace(/"/g, '')}" <${env_1.env.SMTP_FROM_EMAIL.trim()}>`;
    const subject = 'Verify your email address — The Sniff Co.';
    const text = [
        `Hello ${fullName.trim() || 'Pet Parent'},`,
        '',
        'Thank you for creating an account with The Sniff Co.',
        'Please use the verification code below to verify your email address:',
        '',
        `OTP Code: ${otp}`,
        '',
        `This verification code is valid for ${expiresInMinutes} minutes.`,
        'For your security, never share this code with anyone. The Sniff Co. team will never ask you for your OTP.',
        '',
        'Warm regards,',
        'The Sniff Co.',
    ].join('\n');
    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f9f9f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1c1b;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f9f9f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:540px;background-color:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
            <tr>
              <td style="background-color:#104332;padding:24px 32px;text-align:center;">
                <span style="display:inline-block;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">
                  The Sniff Co.
                </span>
                <p style="margin:6px 0 0;color:#baeed5;font-size:12px;letter-spacing:0.04em;">
                  Made for the nose that knows
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 12px;font-size:22px;font-weight:600;color:#002c1e;">
                  Verify your email address
                </h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#404944;">
                  Hello ${safeName},
                </p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#404944;">
                  Thank you for registering with The Sniff Co. Enter the 6-digit verification code below to activate your account:
                </p>
                <div style="background-color:#f4f4f2;border:1px solid #d6ede2;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px;">
                  <span style="display:block;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#104332;margin-bottom:8px;">
                    Your Verification Code
                  </span>
                  <span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:0.28em;color:#002c1e;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">
                    ${otp}
                  </span>
                </div>
                <p style="margin:0 0 12px;font-size:13px;line-height:1.6;color:#404944;">
                  <strong>Expires in ${expiresInMinutes} minutes.</strong> If you did not request this account, you can safely ignore this email.
                </p>
                <p style="margin:0;padding:12px 14px;background-color:#fff8eb;border-radius:8px;font-size:12px;line-height:1.5;color:#5f5e5e;">
                  Security notice: Never share this code with anyone. The Sniff Co. will never ask for your OTP over phone, WhatsApp, or email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="background-color:#f4f4f2;padding:16px 32px;text-align:center;font-size:12px;color:#5f5e5e;">
                © ${new Date().getFullYear()} The Sniff Co. · Made in India
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
    try {
        const transporter = createSmtpTransporter();
        const info = await transporter.sendMail({
            from: fromAddress,
            to: toEmail,
            subject,
            text,
            html,
        });
        const previewUrl = nodemailer_1.default.getTestMessageUrl(info);
        if (env_1.env.NODE_ENV !== 'test') {
            console.info(`OTP verification email dispatched to ${(0, otp_1.maskEmail)(toEmail)} (messageId=${info.messageId})`);
        }
        return { messageId: info.messageId, previewUrl };
    }
    catch (err) {
        if (err instanceof errors_1.AppError)
            throw err;
        console.error(`SMTP email delivery failure for ${(0, otp_1.maskEmail)(toEmail)}:`, err instanceof Error ? err.message : 'Unknown SMTP error');
        throw new errors_1.AppError('Unable to send the verification email due to an email delivery error. Please try again shortly.', 502, 'EMAIL_DELIVERY_FAILED');
    }
}

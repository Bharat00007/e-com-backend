"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isShiprocketConfigured = isShiprocketConfigured;
exports.validateIndianPincode = validateIndianPincode;
exports.checkPincodeServiceability = checkPincodeServiceability;
exports.buildCarrierTrackingUrl = buildCarrierTrackingUrl;
const env_1 = require("../config/env");
function isShiprocketConfigured() {
    return Boolean(env_1.env.SHIPPING_PROVIDER === 'shiprocket' &&
        env_1.env.SHIPROCKET_EMAIL &&
        env_1.env.SHIPROCKET_PASSWORD &&
        !env_1.env.SHIPROCKET_PASSWORD.includes('replace_with'));
}
function validateIndianPincode(pincode) {
    return /^[1-9][0-9]{5}$/.test(pincode);
}
async function checkPincodeServiceability(pincode) {
    if (!validateIndianPincode(pincode)) {
        return {
            pincode,
            serviceable: false,
            codAvailable: false,
            estimatedDays: 'N/A',
            provider: 'indian-postal-validator',
            configuredWithLiveCarrier: false,
        };
    }
    // Modular carrier hook: when Shiprocket credentials are configured, call Shiprocket API here.
    const metroPrefixes = ['11', '40', '41', '56', '60', '50', '70', '38'];
    const isMetro = metroPrefixes.some((p) => pincode.startsWith(p));
    return {
        pincode,
        serviceable: true,
        codAvailable: true,
        estimatedDays: isMetro ? '1–2 business days' : '3–5 business days',
        provider: isShiprocketConfigured() ? 'shiprocket' : 'modular-india-zone',
        configuredWithLiveCarrier: isShiprocketConfigured(),
    };
}
function buildCarrierTrackingUrl(carrier, trackingNumber) {
    if (!carrier || !trackingNumber)
        return null;
    const c = carrier.toLowerCase().trim();
    const num = encodeURIComponent(trackingNumber.trim());
    if (!num)
        return null;
    if (c.includes('delhivery')) {
        return `https://www.delhivery.com/track/package/${num}`;
    }
    if (c.includes('blue dart') || c.includes('bluedart')) {
        return `https://www.bluedart.com/tracking?numbers=${num}`;
    }
    if (c.includes('dtdc')) {
        return `https://www.dtdc.in/tracking/tracking_results.asp?trkType=awb&strCnno=${num}`;
    }
    if (c.includes('shiprocket')) {
        return `https://shiprocket.co/tracking/${num}`;
    }
    if (c.includes('speed post') || c.includes('india post')) {
        return `https://www.indiapost.gov.in/_layouts/15/dpt.cept.trackconsignment/trackconsignment.aspx?consCode=${num}`;
    }
    return null;
}

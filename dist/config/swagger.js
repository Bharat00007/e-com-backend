"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.swaggerSpec = void 0;
const swagger_jsdoc_1 = __importDefault(require("swagger-jsdoc"));
exports.swaggerSpec = (0, swagger_jsdoc_1.default)({
    definition: {
        openapi: '3.0.3',
        info: {
            title: 'The Sniff Co. E-commerce API',
            version: '1.0.0',
            description: 'Production-oriented REST API for The Sniff Co. pet wellness e-commerce platform (Customers, Catalog, Cart, Checkout, Orders, Razorpay Payments, Shipping, Subscriptions, and Admin).',
        },
        servers: [{ url: '/api/v1', description: 'API v1' }],
        components: {
            securitySchemes: {
                cookieAuth: { type: 'apiKey', in: 'cookie', name: 'accessToken' },
                bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            },
        },
    },
    apis: ['./src/routes/*.ts'],
});

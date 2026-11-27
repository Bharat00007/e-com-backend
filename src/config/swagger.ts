import swaggerJsdoc from 'swagger-jsdoc';

export const swaggerSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'The Sniff Co. E-commerce API',
      version: '1.0.0',
      description:
        'Production-oriented REST API for The Sniff Co. pet wellness e-commerce platform (Customers, Catalog, Cart, Checkout, Orders, Razorpay Payments, Shipping, Subscriptions, and Admin).',
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

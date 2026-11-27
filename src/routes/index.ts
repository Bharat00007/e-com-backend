import { Router } from 'express';
import authRoutes from './auth.routes';
import customerRoutes from './customers.routes';
import productRoutes from './products.routes';
import categoryRoutes from './categories.routes';
import cartRoutes from './cart.routes';
import checkoutRoutes from './checkout.routes';
import orderRoutes from './orders.routes';
import paymentRoutes from './payments.routes';
import shippingRoutes from './shipping.routes';
import couponRoutes from './coupons.routes';
import reviewRoutes from './reviews.routes';
import wishlistRoutes from './wishlist.routes';
import subscriptionRoutes from './subscriptions.routes';
import adminRoutes from './admin.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/customers', customerRoutes);
router.use('/products', productRoutes);
router.use('/categories', categoryRoutes);
router.use('/cart', cartRoutes);
router.use('/checkout', checkoutRoutes);
router.use('/orders', orderRoutes);
router.use('/payments', paymentRoutes);
router.use('/shipping', shippingRoutes);
router.use('/coupons', couponRoutes);
router.use('/reviews', reviewRoutes);
router.use('/wishlist', wishlistRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/admin', adminRoutes);

export default router;

import { Router, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { checkPincodeServiceability } from '../services/shippingProvider';
import { NotFoundError } from '../utils/errors';

const router = Router();

router.get('/pincode/:code', async (req: Request, res: Response) => {
  const code = String(req.params.code);
  const result = await checkPincodeServiceability(code);
  res.json({ success: true, data: result });
});

router.get('/track/:trackingNumber', async (req: Request, res: Response) => {
  const trackingNumber = String(req.params.trackingNumber);
  const shipment = await prisma.shipment.findUnique({
    where: { trackingNumber },
    include: {
      order: {
        select: { orderNumber: true, status: true, createdAt: true },
      },
    },
  });
  if (!shipment) throw new NotFoundError('Shipment tracking record not found');
  res.json({ success: true, data: shipment });
});

export default router;

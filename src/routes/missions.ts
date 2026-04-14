import { Router } from 'express';
import { authenticate } from '../middleware/auth';
const router = Router();
router.get('/', authenticate, (_req, res) => res.json([]));
router.post('/', authenticate, (req, res) => res.json({ id: require("uuid").v4(), ...req.body, createdAt: new Date() }));
router.patch('/:id', authenticate, (req, res) => res.json({ id: req.params.id, ...req.body }));
export default router;

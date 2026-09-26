import { Router } from "express";
const router = Router();
router.post("/", (req, res) => res.json({ id: "123" }));
export default router;

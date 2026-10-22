import { Router } from "express";
import workflows from "../workflows/index.js";
import runs from "../runs/index.js";

// Mounted at /api.
const api = Router();

api.get("/health", (req, res) => {
  res.json({ status: "ok" });
});
api.use("/workflows", workflows);
api.use("/runs", runs);
api.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

export default api;

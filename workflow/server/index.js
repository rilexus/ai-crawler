import express from "express";
import api from "./routers/api/index.js";
import { startSyncing } from "./apps.js";
import { attachSocket } from "./socket.js";

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());
app.use("/api", api);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
  startSyncing();
});
attachSocket(server);

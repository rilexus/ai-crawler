const express = require("express");

const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});

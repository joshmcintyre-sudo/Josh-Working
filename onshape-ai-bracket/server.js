import express from "express";
import { fileURLToPath } from "node:url";
import { parseRequest } from "./src/llm.js";
import { sizeBracket } from "./src/engineering.js";
import { insertBracket, onshapeConfigured } from "./src/onshape.js";

const app = express();
app.use(express.json());

// Optional shared secret so only your Onshape extension can spend API credits.
app.use("/api", (req, res, next) => {
  const token = process.env.PANEL_TOKEN;
  if (token && req.get("x-panel-token") !== token) return res.status(401).json({ error: "Bad panel token" });
  next();
});

app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));

app.get("/api/status", (_req, res) => res.json({ onshape: onshapeConfigured() }));

// Plain English -> spec (Claude) -> sized design (deterministic).
app.post("/api/design", async (req, res) => {
  try {
    const { query, current } = req.body;
    if (!query) return res.status(400).json({ error: "query is required" });
    const spec = await parseRequest(query, current);
    const design = sizeBracket(spec);
    res.json({ spec, design });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-size from an edited spec without calling the model (e.g. user changes material in the panel).
app.post("/api/resize", (req, res) => {
  try {
    res.json({ spec: req.body.spec, design: sizeBracket(req.body.spec) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/insert", async (req, res) => {
  try {
    if (!onshapeConfigured()) return res.status(400).json({ error: "Onshape keys / FS_* env vars not set" });
    const { documentId, workspaceId, elementId, geometry, name } = req.body;
    const result = await insertBracket({ documentId, workspaceId, elementId }, geometry, name);
    res.json({ ok: true, featureId: result.feature?.featureId, state: result.featureState?.featureStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AI Bracket panel on http://localhost:${port}`));

import "dotenv/config";
import { createApp } from "./app.js";

const port = Number(process.env.PORT || 8787);
const app = createApp();

app.listen(port, () => {
  const mode = process.env.CLINICFLOW_DEMO_MODE === "1" || !process.env.OPENAI_API_KEY ? "demo" : "openai";
  console.log(`ClinicFlow AI server listening on http://localhost:${port} (${mode} mode)`);
});

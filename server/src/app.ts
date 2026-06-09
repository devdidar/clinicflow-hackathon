import express from "express";
import cors from "cors";
import { run } from "@openai/agents";
import { createClinicReceptionistAgent } from "../../agents/clinicReceptionist.js";
import { clinicStore } from "../../memory/store.js";
import type { ClinicRunContext, ToolEvent } from "../../tools/clinicTools.js";
import { extractRunItemToolLabel, extractTextDelta, openSse, sendSse } from "./streaming.js";
import { runDemoReceptionist } from "./demoAgent.js";
import { resolveIncomingSession } from "./sessionRouting.js";
import { formatIdentityConflictLog } from "./identityConflict.js";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "ClinicFlow AI",
      demoMode: process.env.CLINICFLOW_DEMO_MODE === "1" || !process.env.OPENAI_API_KEY
    });
  });

  app.get("/api/dashboard", (_req, res) => {
    res.json(clinicStore.getDashboard());
  });

  app.get("/api/memory/:patientId", (req, res) => {
    const patient = clinicStore.findPatient({ patientId: req.params.patientId });
    if (!patient) {
      res.status(404).json({ ok: false, error: "Patient not found" });
      return;
    }
    const data = clinicStore.getSnapshot();
    res.json({
      ok: true,
      patient,
      appointments: patient.appointmentHistory.map((appointmentId) => data.appointments[appointmentId]).filter(Boolean)
    });
  });

  app.post("/api/chat/stream", async (req, res) => {
    const { message, sessionId = "default", patientId, phoneNumber } = req.body as {
      message?: string;
      sessionId?: string;
      patientId?: string;
      phoneNumber?: string;
    };

    if (!message?.trim()) {
      res.status(400).json({ ok: false, error: "message is required" });
      return;
    }

    openSse(res);
    const startedAt = Date.now();
    const demoMode = process.env.CLINICFLOW_DEMO_MODE === "1" || !process.env.OPENAI_API_KEY;
    const route = resolveIncomingSession({ sessionId, patientId, phoneNumber, message });
    if (route.invalidPhone) {
      sendSse(res, "error", {
        ok: false,
        error: "Invalid Bangladesh phone metadata. Use +8801XXXXXXXXX format."
      });
      res.end();
      return;
    }
    clinicStore.appendSessionTurn(route.sessionId, { role: "user", content: message, createdAt: new Date().toISOString() });

    const emitToolEvent = (event: ToolEvent) => sendSse(res, "tool", event);
    let assistantText = "";
    let resolvedPatientId = route.patientId;

    try {
      sendSse(res, "status", { state: demoMode ? "demo_stream_started" : "agent_stream_started" });
      if (route.switched) {
        sendSse(res, "session_switch", {
          previousSessionId: route.previousSessionId,
          sessionId: route.sessionId,
          reason: route.reason,
          phoneNumber: route.phoneNumber,
          patientName: route.patientName,
          patientId: route.patientId
        });
      }

      if (route.identityConflict) {
        const message = formatIdentityConflictLog({ claimedName: route.claimedName, verifiedName: route.patientName });
        sendSse(res, "identity_conflict", {
          claimedName: route.claimedName,
          verifiedName: route.patientName,
          phoneNumber: route.phoneNumber,
          message
        });
        emitToolEvent({
          id: `identity_conflict_${Date.now()}`,
          toolName: "identity_conflict",
          status: "completed",
          label: message,
          payload: {
            claimedName: route.claimedName,
            verifiedName: route.patientName,
            phoneNumber: route.phoneNumber
          }
        });
      }

      if (route.switched || route.phoneNumber) {
        const patient = clinicStore.findPatient({
          patientId: route.patientId,
          name: route.patientName,
          contactPhone: route.phoneNumber
        });
        const data = clinicStore.getSnapshot();
        emitToolEvent({
          id: `route_lookup_${Date.now()}`,
          toolName: "fetch_patient_history",
          status: "completed",
          label: patient ? `Found record for ${patient.name}` : "No existing record found",
          payload: {
            patient: patient ?? null,
            appointments: patient ? patient.appointmentHistory.map((appointmentId) => data.appointments[appointmentId]).filter(Boolean) : []
          }
        });
      }

      if (demoMode) {
        const result = await runDemoReceptionist({
          res,
          sessionId: route.sessionId,
          patientId: route.patientId,
          message,
          identityConflict: route.identityConflict ? { claimedName: route.claimedName, verifiedName: route.patientName } : undefined
        });
        assistantText = result.reply;
        resolvedPatientId = result.patientId ?? route.patientId;
      } else {
        const patient = route.patientId ? clinicStore.findPatient({ patientId: route.patientId }) : undefined;
        const sessionTurns = clinicStore.getSessionTurns(route.sessionId);
        const agent = createClinicReceptionistAgent({ patient, sessionTurns, demoMode });
        const context: ClinicRunContext = { patientId: route.patientId, sessionId: route.sessionId, emitToolEvent };
        const stream = await run(agent, message, { stream: true, context });
        const seenToolLabels = new Set<string>();

        for await (const event of stream) {
          const delta = extractTextDelta(event);
          if (delta) {
            assistantText += delta;
            sendSse(res, "delta", { text: delta });
          }

          const label = extractRunItemToolLabel(event);
          if (label && !seenToolLabels.has(label)) {
            seenToolLabels.add(label);
            sendSse(res, "tool", {
              id: `sdk_${seenToolLabels.size}_${Date.now()}`,
              toolName: label,
              status: "started",
              label: `Running ${label}...`
            });
          }
        }

        await stream.completed;
        if (!assistantText && typeof stream.finalOutput === "string") {
          assistantText = stream.finalOutput;
          sendSse(res, "delta", { text: stream.finalOutput });
        }
      }

      clinicStore.appendSessionTurn(route.sessionId, {
        role: "assistant",
        content: assistantText,
        createdAt: new Date().toISOString()
      });
      const verifiedPatient = resolvedPatientId ? clinicStore.findPatient({ patientId: resolvedPatientId }) : undefined;
      if (resolvedPatientId || route.phoneNumber || route.patientName) {
        clinicStore.upsertSessionProfile({
          sessionId: route.sessionId,
          patientId: resolvedPatientId,
          phoneNumber: route.phoneNumber,
          patientName: verifiedPatient?.name ?? route.patientName
        });
      }
      sendSse(res, "done", {
        ok: true,
        elapsedMs: Date.now() - startedAt,
        sessionId: route.sessionId,
        switched: route.switched,
        phoneNumber: route.phoneNumber,
        patientName: verifiedPatient?.name ?? route.patientName,
        patientId: resolvedPatientId,
        assistantText
      });
      res.end();
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown server error";
      sendSse(res, "error", { ok: false, error: messageText });
      res.end();
    }
  });

  return app;
}

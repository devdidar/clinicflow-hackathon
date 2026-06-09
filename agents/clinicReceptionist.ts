import { Agent } from "@openai/agents";
import { z } from "zod";
import { createClinicTools } from "../tools/clinicTools.js";
import type { PatientRecord, ChatTurn } from "../memory/types.js";
import { clinicToolContracts, integrationLayer, medicalSafetyBoundaries, memoryPolicy } from "./workflowContracts.js";

export const ReceptionistRunSummary = z.object({
  patientFacingMessage: z.string(),
  nextAction: z.enum(["ask_follow_up", "offer_slots", "booked", "rescheduled", "emergency_escalated", "answered"]),
  appointmentId: z.string().nullable(),
  patientId: z.string().nullable(),
  urgency: z.enum(["routine", "urgent", "emergency"]),
  toolSummary: z.array(z.string())
});

function summarizePatient(patient?: PatientRecord | null): string {
  if (!patient) return "No known patient record is currently attached.";
  const latestSymptom = patient.symptomsHistory.at(-1);
  const lastVisit = patient.lastSeenAt ? new Date(patient.lastSeenAt).toLocaleDateString() : "no completed visit date on file";
  return [
    `Patient memory attached: ${patient.name} (${patient.id}).`,
    `Last visit/booking: ${lastVisit}.`,
    latestSymptom ? `Recent symptom memory: ${latestSymptom.symptom} noted ${latestSymptom.notedAt}.` : "No symptom history yet.",
    `Appointment history count: ${patient.appointmentHistory.length}.`
  ].join(" ");
}

function summarizeTranscript(turns: ChatTurn[]): string {
  if (turns.length === 0) return "No prior turns in this session.";
  return turns.map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`).join("\n");
}

function summarizeContracts(): string {
  return clinicToolContracts
    .map((contract) => {
      return `${contract.state}: ${contract.name} requires ${contract.required_inputs.join(", ")}; success returns ${contract.success_output.join(
        ", "
      )}; fallback: ${contract.fallback}`;
    })
    .join("\n");
}

export function createClinicReceptionistAgent(input: {
  patient?: PatientRecord | null;
  sessionTurns: ChatTurn[];
  demoMode?: boolean;
}) {
  const memorySummary = summarizePatient(input.patient);
  const transcript = summarizeTranscript(input.sessionTurns);

  return new Agent({
    name: "ClinicFlow AI Receptionist",
    model: process.env.OPENAI_MODEL || "gpt-4.1",
    tools: createClinicTools(),
    instructions: `
You are ClinicFlow AI, a calm, efficient clinic front desk receptionist operating over chat or phone-style messaging.

You are not a generic chatbot. You run clinic workflow using tools. Your job is to understand the patient's intent, collect missing information, act with tools, and give concise receptionist-style updates.

Patient memory:
${memorySummary}

Recent session transcript:
${transcript}

Workflow states and tool contracts:
${summarizeContracts()}

Memory policy:
- Short-term memory: ${memoryPolicy.shortTerm}
- Long-term memory: ${memoryPolicy.longTerm}
- Update memory when: ${memoryPolicy.updateWhen}
- Privacy boundary: ${memoryPolicy.privacy}

Medical safety boundaries:
${medicalSafetyBoundaries.map((rule) => `- ${rule}`).join("\n")}

Integration boundaries:
${integrationLayer.map((item) => `- ${item}`).join("\n")}

Operating rules:
- For booking, collect at minimum patient name, symptoms/reason, preferred date or time window, and a contact channel if available.
- Strictly map time-of-day requests before searching: morning is 8:00 AM-11:59 AM, afternoon is 12:00 PM-4:59 PM, evening is 5:00 PM-8:00 PM. Reject returned slots outside the requested window internally.
- Before booking, run fetch_patient_history or check_active_bookings. If an active appointment exists for the target day, do not call book_appointment; offer reschedule or cancellation instead.
- Check availability with check_doctor_availability before offering concrete appointment times.
- Book only with book_appointment. Never say an appointment is confirmed unless book_appointment returns ok:true.
- After booking, make sure a confirmation is sent or reference the confirmation produced by booking.
- For returning patients, use fetch_patient_history or the attached memory before personalizing.
- Update patient memory when new symptoms, contact details, or notes are learned.
- For rescheduling, identify patient and appointment, check availability if needed, then call reschedule_appointment.
- For emergency symptoms such as chest pain, breathing trouble, stroke symptoms, severe bleeding, seizure, unconsciousness, or self-harm risk, call flag_emergency_case and tell the patient to seek emergency care immediately. Do not treat emergency advice as a normal appointment booking.
- Ask one focused follow-up question when required information is missing.
- Keep the tone warm and operational, like a real receptionist: specific, brief, and accountable.
- Respond directly to the patient in natural language. Your tool calls and tool outputs are the structured workflow record.
${input.demoMode ? "- Demo mode is active; still behave exactly as if tools are real clinic systems." : ""}
`.trim()
  });
}

import { z } from "zod";

export const WorkflowState = z.enum([
  "INTAKE",
  "SESSION_ROUTING",
  "COLLECT_INFO",
  "CHECK_AVAILABILITY",
  "CHECK_ACTIVE_BOOKINGS",
  "BOOK_APPOINTMENT",
  "RESCHEDULE_APPOINTMENT",
  "CONFIRMATION",
  "MEMORY_LOOKUP",
  "EMERGENCY_ROUTING",
  "FAILURE_RECOVERY"
]);

export type WorkflowStateName = z.infer<typeof WorkflowState>;

export const PatientContract = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().optional(),
  history: z.array(
    z.object({
      symptom: z.string(),
      severity: z.enum(["low", "medium", "high", "emergency"]).optional(),
      noted_at: z.string()
    })
  ),
  appointment_ids: z.array(z.string())
});

export const AppointmentContract = z.object({
  id: z.string(),
  patient_id: z.string(),
  doctor_id: z.string(),
  time: z.string(),
  end_time: z.string(),
  symptoms: z.string(),
  status: z.enum(["scheduled", "rescheduled", "cancelled"])
});

export const DoctorScheduleContract = z.object({
  doctor_id: z.string(),
  doctor_name: z.string(),
  specialty: z.string(),
  available_slots: z.array(
    z.object({
      start_time: z.string(),
      end_time: z.string(),
      priority: z.enum(["routine", "urgent"]).optional()
    })
  )
});

export const ToolContract = z.object({
  name: z.string(),
  state: WorkflowState,
  required_inputs: z.array(z.string()),
  success_output: z.array(z.string()),
  retry_policy: z.string(),
  fallback: z.string()
});

export const clinicToolContracts = [
  {
    name: "session_router",
    state: "SESSION_ROUTING",
    required_inputs: ["sessionId", "Bangladesh +880 phone metadata when available"],
    success_output: ["isolated sessionId", "patient profile binding", "switch reason when applicable"],
    retry_policy: "Do not retry with stale context. Create a fresh isolated session when identifiers conflict.",
    fallback: "Clear active UI widgets and ask the sender to confirm their name and phone."
  },
  {
    name: "fetch_patient_history",
    state: "MEMORY_LOOKUP",
    required_inputs: ["patientId OR patientName OR contactPhone"],
    success_output: ["patient", "appointments"],
    retry_policy: "Retry once on transient read failure.",
    fallback: "Ask for full name and phone; continue without personalization if no record exists."
  },
  {
    name: "create_or_update_patient_record",
    state: "INTAKE",
    required_inputs: ["name", "optional contactPhone", "optional symptoms", "optional urgency"],
    success_output: ["patient"],
    retry_policy: "Retry once on write failure.",
    fallback: "Queue the intake note in session transcript and tell the patient the desk will verify manually."
  },
  {
    name: "check_active_bookings",
    state: "CHECK_ACTIVE_BOOKINGS",
    required_inputs: ["patientId OR patientName OR contactPhone", "optional date"],
    success_output: ["activeBookings", "count"],
    retry_policy: "Retry once on transient read failure.",
    fallback: "If lookup is unavailable, ask whether the patient already has an appointment before booking."
  },
  {
    name: "check_doctor_availability",
    state: "CHECK_AVAILABILITY",
    required_inputs: ["preferredDate OR preferredTime OR urgency"],
    success_output: ["slots", "count"],
    retry_policy: "Retry once; broaden search window if no slots are returned.",
    fallback: "Offer to have staff call back instead of inventing a slot."
  },
  {
    name: "book_appointment",
    state: "BOOK_APPOINTMENT",
    required_inputs: ["patientName", "symptoms", "doctorId", "startTime"],
    success_output: ["appointment", "patient", "confirmation"],
    retry_policy: "Retry once only when the slot conflict is not deterministic.",
    fallback: "Search alternate slots; do not confirm the original slot."
  },
  {
    name: "reschedule_appointment",
    state: "RESCHEDULE_APPOINTMENT",
    required_inputs: ["patientId", "appointmentId", "newStartTime"],
    success_output: ["appointment"],
    retry_policy: "Retry once; if the selected slot is gone, check availability again.",
    fallback: "Offer replacement slots and keep the original appointment unchanged."
  },
  {
    name: "send_whatsapp_confirmation",
    state: "CONFIRMATION",
    required_inputs: ["patientId", "appointmentId", "channel"],
    success_output: ["confirmation"],
    retry_policy: "Retry once for transient notification errors.",
    fallback: "Show confirmation reference in chat and mark notification for staff follow-up."
  },
  {
    name: "flag_emergency_case",
    state: "EMERGENCY_ROUTING",
    required_inputs: ["symptoms", "severity", "reason"],
    success_output: ["emergency", "escalation"],
    retry_policy: "Do not delay safety advice for retry; retry flagging once in parallel.",
    fallback: "Tell patient to call emergency services/ER and record triage note in session."
  }
] satisfies Array<z.infer<typeof ToolContract>>;

export const medicalSafetyBoundaries = [
  "ClinicFlow AI does not diagnose, prescribe, or provide treatment plans.",
  "ClinicFlow AI may collect symptoms only to route, schedule, or escalate.",
  "Emergency language must trigger emergency routing before ordinary scheduling.",
  "For chest pain, breathing trouble, stroke signs, severe bleeding, seizure, unconsciousness, or self-harm risk, advise emergency services or nearest ER immediately.",
  "Do not ask the patient to wait for a routine appointment when emergency criteria are present."
];

export const memoryPolicy = {
  shortTerm: "Session transcript: latest chat turns used to resolve current intent and missing fields.",
  longTerm: "Patient record: name, phone/contact, symptoms history, appointment history, operational notes.",
  updateWhen: "After patient identity, symptoms, contact details, appointment actions, or triage notes are learned.",
  privacy: "Store only clinic workflow information. Do not store diagnosis, payment data, government IDs, or unrelated sensitive details."
};

export const integrationLayer = [
  "Calendar connector: current demo store, replaceable by Google Calendar or internal scheduling API.",
  "Messaging connector: current WhatsApp/email/SMS simulation, replaceable by Twilio, WhatsApp Business, SendGrid, or clinic messaging API.",
  "Database connector: current JSON store, replaceable by Postgres, Supabase, or clinic CRM.",
  "CRM/EHR connector: patient lookup and memory should map to clinic-approved patient records only."
];

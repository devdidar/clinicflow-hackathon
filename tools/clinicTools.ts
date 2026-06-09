import { tool } from "@openai/agents";
import { z } from "zod";
import { clinicStore } from "../memory/store.js";

export interface ToolEvent {
  id: string;
  toolName: string;
  status: "started" | "completed" | "failed";
  label: string;
  payload?: unknown;
}

export interface ClinicRunContext {
  patientId?: string;
  sessionId: string;
  emitToolEvent?: (event: ToolEvent) => void;
}

const urgentSymptoms = [
  "chest pain",
  "shortness of breath",
  "trouble breathing",
  "stroke",
  "severe bleeding",
  "unconscious",
  "seizure",
  "suicidal"
];

function toolContext(context: unknown): ClinicRunContext {
  const maybeWrapped = context as { context?: ClinicRunContext };
  return maybeWrapped?.context ?? (context as ClinicRunContext);
}

function emit(context: unknown, event: ToolEvent) {
  toolContext(context)?.emitToolEvent?.(event);
}

async function withRetry<T>(operation: () => Promise<T> | T, retries = 1): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  throw lastError;
}

function toolError(name: string, error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown tool error";
  return {
    ok: false,
    tool: name,
    error: message,
    retryable: /timeout|temporar|busy|locked/i.test(message)
  };
}

const availabilityParams = z.object({
  preferredDate: z.string().optional().describe("Preferred date in YYYY-MM-DD format, if known."),
  preferredTime: z.string().optional().describe("Patient's preferred time, such as morning, 2pm, or 14:30."),
  symptomCategory: z.string().optional().describe("Brief category such as fever, dental pain, cough, checkup."),
  urgency: z.enum(["routine", "urgent"]).default("routine")
});

const bookParams = z.object({
  patientId: z.string().optional(),
  patientName: z.string().min(1),
  contactPhone: z.string().optional(),
  symptoms: z.string().min(1),
  doctorId: z.string().min(1),
  startTime: z.string().describe("ISO timestamp from check_doctor_availability."),
  channel: z.enum(["whatsapp", "email", "sms"]).default("whatsapp")
});

const rescheduleParams = z.object({
  patientId: z.string().min(1),
  appointmentId: z.string().min(1),
  doctorId: z.string().optional(),
  newStartTime: z.string().describe("Requested ISO timestamp or date for the new appointment.")
});

const patientLookupParams = z.object({
  patientId: z.string().optional(),
  patientName: z.string().optional(),
  contactPhone: z.string().optional()
});

const activeBookingsParams = z.object({
  patientId: z.string().optional(),
  patientName: z.string().optional(),
  contactPhone: z.string().optional(),
  date: z.string().optional().describe("Optional target date or ISO timestamp. If omitted, returns all active bookings.")
});

const updatePatientParams = z.object({
  patientId: z.string().optional(),
  name: z.string().min(1),
  contactPhone: z.string().optional(),
  symptoms: z.string().optional(),
  urgency: z.enum(["low", "medium", "high", "emergency"]).optional(),
  notes: z.string().optional()
});

const confirmationParams = z.object({
  patientId: z.string().min(1),
  appointmentId: z.string().min(1),
  destination: z.string().optional(),
  channel: z.enum(["whatsapp", "email", "sms"]).default("whatsapp")
});

const emergencyParams = z.object({
  patientId: z.string().optional(),
  patientName: z.string().optional(),
  symptoms: z.string().min(1),
  severity: z.enum(["high", "emergency"]).default("emergency"),
  reason: z.string().min(1)
});

export function createClinicTools() {
  return [
    tool({
      name: "check_doctor_availability",
      description: "Check real clinic appointment slots. Use before offering or booking a specific appointment.",
      parameters: availabilityParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_availability`;
        emit(context, { id, toolName: "check_doctor_availability", status: "started", label: "Checking availability..." });
        try {
          const slots = await withRetry(() => clinicStore.checkAvailability(input));
          const result = { ok: true, slots, count: slots.length };
          emit(context, {
            id,
            toolName: "check_doctor_availability",
            status: "completed",
            label: `Found ${slots.length} available slots`,
            payload: result
          });
          return result;
        } catch (error) {
          const result = toolError("check_doctor_availability", error);
          emit(context, { id, toolName: "check_doctor_availability", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    }),

    tool({
      name: "book_appointment",
      description:
        "Book an appointment after patient name, symptoms, doctorId, and startTime are known. Never claim a booking exists until this succeeds.",
      parameters: bookParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_book`;
        emit(context, { id, toolName: "book_appointment", status: "started", label: "Booking appointment..." });
        try {
          const activeBookings = clinicStore.getActiveBookings({
            patientId: input.patientId || toolContext(context)?.patientId,
            patientName: input.patientName,
            contactPhone: input.contactPhone,
            date: input.startTime
          });
          if (activeBookings.length > 0) {
            const result = {
              ok: false,
              code: "ACTIVE_BOOKING_EXISTS",
              activeBooking: activeBookings[0],
              message: "Patient already has an active appointment for this date. Offer reschedule or cancellation instead."
            };
            emit(context, {
              id,
              toolName: "book_appointment",
              status: "completed",
              label: "Active appointment already exists",
              payload: result
            });
            return result;
          }
          const booking = await withRetry(() => clinicStore.bookAppointment(input));
          const confirmation = clinicStore.sendConfirmation({
            patientId: booking.patient.id,
            appointmentId: booking.appointment.id,
            channel: input.channel,
            destination: input.contactPhone
          });
          const result = {
            ok: true,
            appointment: booking.appointment,
            patient: booking.patient,
            confirmation
          };
          emit(context, {
            id,
            toolName: "book_appointment",
            status: "completed",
            label: "Appointment booked and confirmation queued",
            payload: result
          });
          return result;
        } catch (error) {
          const result = toolError("book_appointment", error);
          emit(context, { id, toolName: "book_appointment", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    }),

    tool({
      name: "reschedule_appointment",
      description: "Move an existing appointment to another available slot after identifying the patient and appointment.",
      parameters: rescheduleParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_reschedule`;
        emit(context, { id, toolName: "reschedule_appointment", status: "started", label: "Rescheduling appointment..." });
        try {
          const appointment = await withRetry(() => clinicStore.rescheduleAppointment(input));
          const result = { ok: true, appointment };
          emit(context, { id, toolName: "reschedule_appointment", status: "completed", label: "Appointment rescheduled", payload: result });
          return result;
        } catch (error) {
          const result = toolError("reschedule_appointment", error);
          emit(context, { id, toolName: "reschedule_appointment", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    }),

    tool({
      name: "fetch_patient_history",
      description: "Fetch patient-level memory including past symptoms and appointments. Use for returning patients when any identifier is available.",
      parameters: patientLookupParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_history`;
        emit(context, { id, toolName: "fetch_patient_history", status: "started", label: "Looking up patient memory..." });
        try {
          const patient = clinicStore.findPatient({
            patientId: input.patientId || toolContext(context)?.patientId,
            name: input.patientName,
            contactPhone: input.contactPhone
          });
          const data = clinicStore.getSnapshot();
          const appointments = patient ? patient.appointmentHistory.map((appointmentId) => data.appointments[appointmentId]).filter(Boolean) : [];
          const result = { ok: true, patient: patient ?? null, appointments };
          emit(context, {
            id,
            toolName: "fetch_patient_history",
            status: "completed",
            label: patient ? `Found record for ${patient.name}` : "No existing record found",
            payload: result
          });
          return result;
        } catch (error) {
          const result = toolError("fetch_patient_history", error);
          emit(context, { id, toolName: "fetch_patient_history", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    }),

    tool({
      name: "check_active_bookings",
      description:
        "Check whether a patient already has an active scheduled or rescheduled appointment. Run before booking to prevent duplicate appointment loops.",
      parameters: activeBookingsParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_active_bookings`;
        emit(context, { id, toolName: "check_active_bookings", status: "started", label: "Checking active bookings..." });
        try {
          const bookings = clinicStore.getActiveBookings({
            patientId: input.patientId || toolContext(context)?.patientId,
            patientName: input.patientName,
            contactPhone: input.contactPhone,
            date: input.date
          });
          const result = { ok: true, activeBookings: bookings, count: bookings.length };
          emit(context, {
            id,
            toolName: "check_active_bookings",
            status: "completed",
            label: bookings.length > 0 ? "Active appointment found" : "No active appointment found",
            payload: result
          });
          return result;
        } catch (error) {
          const result = toolError("check_active_bookings", error);
          emit(context, { id, toolName: "check_active_bookings", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    }),

    tool({
      name: "create_or_update_patient_record",
      description: "Create or update patient memory with name, contact details, symptoms, notes, and urgency.",
      parameters: updatePatientParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_patient`;
        emit(context, { id, toolName: "create_or_update_patient_record", status: "started", label: "Updating patient record..." });
        try {
          const patient = clinicStore.upsertPatient({
            patientId: input.patientId || toolContext(context)?.patientId,
            name: input.name,
            contactPhone: input.contactPhone,
            symptoms: input.symptoms,
            severity: input.urgency,
            note: input.notes
          });
          const result = { ok: true, patient };
          emit(context, {
            id,
            toolName: "create_or_update_patient_record",
            status: "completed",
            label: `Updated record for ${patient.name}`,
            payload: result
          });
          return result;
        } catch (error) {
          const result = toolError("create_or_update_patient_record", error);
          emit(context, { id, toolName: "create_or_update_patient_record", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    }),

    tool({
      name: "send_whatsapp_confirmation",
      description: "Send a simulated WhatsApp/email/SMS confirmation after a booking or reschedule succeeds.",
      parameters: confirmationParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_confirm`;
        emit(context, { id, toolName: "send_whatsapp_confirmation", status: "started", label: "Sending confirmation..." });
        try {
          const confirmation = clinicStore.sendConfirmation(input);
          const result = { ok: true, confirmation };
          emit(context, {
            id,
            toolName: "send_whatsapp_confirmation",
            status: "completed",
            label: `${input.channel} confirmation sent`,
            payload: result
          });
          return result;
        } catch (error) {
          const result = toolError("send_whatsapp_confirmation", error);
          emit(context, { id, toolName: "send_whatsapp_confirmation", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    }),

    tool({
      name: "flag_emergency_case",
      description:
        "Flag urgent or emergency symptoms before normal booking. Use for chest pain, breathing trouble, stroke symptoms, severe bleeding, seizure, unconsciousness, or self-harm risk.",
      parameters: emergencyParams,
      async execute(input, context) {
        const id = `tool_${Date.now()}_emergency`;
        emit(context, { id, toolName: "flag_emergency_case", status: "started", label: "Flagging emergency case..." });
        try {
          const emergency = clinicStore.flagEmergency(input);
          const result = {
            ok: true,
            emergency,
            escalation: "Advise immediate emergency services / nearest ER, then offer to notify clinic triage."
          };
          emit(context, {
            id,
            toolName: "flag_emergency_case",
            status: "completed",
            label: "Emergency flagged for triage",
            payload: result
          });
          return result;
        } catch (error) {
          const result = toolError("flag_emergency_case", error);
          emit(context, { id, toolName: "flag_emergency_case", status: "failed", label: result.error, payload: result });
          return result;
        }
      }
    })
  ];
}

export function locallyLooksUrgent(message: string): boolean {
  const normalized = message.toLowerCase();
  return urgentSymptoms.some((symptom) => normalized.includes(symptom));
}

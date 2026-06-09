import type { Response } from "express";
import { clinicStore } from "../../memory/store.js";
import { locallyLooksUrgent, type ToolEvent } from "../../tools/clinicTools.js";
import { sendSse } from "./streaming.js";
import { normalizePhone } from "./sessionRouting.js";

function pickName(message: string): string {
  const match = message.match(/(?:i am|i'm|name is|this is)\s+([a-z][a-z\s'-]{1,40}?)(?:[,.!?]|\s+(?:and|with|for|because|please)\b|$)/i);
  return match?.[1]?.trim() || "Demo Patient";
}

function pickSymptoms(message: string): string {
  const symptomMatch = message.match(/(?:for|because of|with|having|about)\s+([^,.!?]{3,90})/i);
  return symptomMatch?.[1]?.trim() || "general consultation";
}

function pickPhone(message: string): string | undefined {
  return normalizePhone(message.match(/(\+?\d[\d\s-]{5,}\d)/)?.[1]);
}

function wantsAfternoon(message: string): boolean {
  return /afternoon|pm|12\s?p|1\s?p|2\s?p|3\s?p|4\s?p/i.test(message);
}

function wantsMorning(message: string): boolean {
  return /morning|am|9\s?a|10\s?a|11\s?a/i.test(message);
}

function preferredTime(message: string): string {
  if (/evening|5\s?p|6\s?p|7\s?p|8\s?p/i.test(message)) return "evening";
  if (wantsAfternoon(message)) return "14:00";
  if (wantsMorning(message)) return "09:00";
  return "09:00";
}

function formatAppointmentTime(startTime: string): string {
  return new Date(startTime).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function sendTool(res: Response, event: ToolEvent) {
  sendSse(res, "tool", event);
}

async function streamText(res: Response, text: string) {
  const chunks = text.match(/.{1,18}(\s|$)/g) ?? [text];
  for (const chunk of chunks) {
    sendSse(res, "delta", { text: chunk });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function runDemoReceptionist(input: {
  res: Response;
  sessionId: string;
  patientId?: string;
  message: string;
  identityConflict?: { claimedName?: string; verifiedName?: string };
}) {
  const lower = input.message.toLowerCase();

  if (locallyLooksUrgent(input.message)) {
    const id = "demo_emergency";
    sendTool(input.res, { id, toolName: "flag_emergency_case", status: "started", label: "Flagging emergency case..." });
    const emergency = clinicStore.flagEmergency({
      patientId: input.patientId,
      patientName: pickName(input.message),
      symptoms: pickSymptoms(input.message),
      severity: "emergency",
      reason: "Demo triage detected emergency symptom language."
    });
    sendTool(input.res, {
      id,
      toolName: "flag_emergency_case",
      status: "completed",
      label: "Emergency flagged for triage",
      payload: emergency
    });
    const reply =
      `${input.identityConflict?.claimedName ? `[IDENTITY CONFLICT DETECTED: Sender claims to be ${input.identityConflict.claimedName} from ${input.identityConflict.verifiedName ?? "another patient's"} device] ` : ""}I have flagged this as urgent for clinic triage. If you are having chest pain, trouble breathing, stroke symptoms, severe bleeding, or feel unsafe, please call emergency services or go to the nearest ER now. I can stay here to help notify the clinic, but this should not wait for a routine appointment.`;
    await streamText(input.res, reply);
    return { reply };
  }

  if (/(history|record|last visit|visited|remember|previous)/i.test(lower)) {
    const id = "demo_history";
    const name = pickName(input.message);
    const phone = pickPhone(input.message);
    sendTool(input.res, { id, toolName: "fetch_patient_history", status: "started", label: "Looking up patient memory..." });
    const patient = clinicStore.findPatient({ patientId: input.patientId, name, contactPhone: phone });
    const snapshot = clinicStore.getSnapshot();
    const appointments = patient ? patient.appointmentHistory.map((appointmentId) => snapshot.appointments[appointmentId]).filter(Boolean) : [];
    sendTool(input.res, {
      id,
      toolName: "fetch_patient_history",
      status: "completed",
      label: patient ? `Found record for ${patient.name}` : "No existing record found",
      payload: { patient: patient ?? null, appointments }
    });
    const latestSymptom = patient?.symptomsHistory.at(-1)?.symptom;
    const reply = patient
      ? `Welcome back, ${patient.name}. I found ${appointments.length} appointment${appointments.length === 1 ? "" : "s"} on your record${latestSymptom ? `, including your recent visit reason: ${latestSymptom}` : ""}. What would you like to do next?`
      : "I could not find an existing patient record from that information. May I have the patient's full name and phone number?";
    await streamText(input.res, reply);
    return { reply, patientId: patient?.id };
  }

  if (/(available|availability|open slot|time slot|who is free)/i.test(lower) && !/(book|schedule|reschedule)/i.test(lower)) {
    const id = "demo_availability";
    sendTool(input.res, { id, toolName: "check_doctor_availability", status: "started", label: "Checking availability..." });
    const slots = clinicStore.checkAvailability({ preferredTime: preferredTime(input.message) });
    sendTool(input.res, {
      id,
      toolName: "check_doctor_availability",
      status: "completed",
      label: `Found ${slots.length} available slots`,
      payload: { slots }
    });
    const topSlots = slots
      .slice(0, 3)
      .map((slot) => `${slot.doctorName} at ${new Date(slot.startTime).toLocaleString()}`)
      .join("; ");
    const reply =
      slots.length > 0
        ? `I found these available clinic slots: ${topSlots}. If one works, send your full name, symptom or visit reason, and contact number so I can book it.`
        : "I checked that exact time window and do not see any matching slots. Would you like me to search another time of day?";
    await streamText(input.res, reply);
    return { reply };
  }

  if (/(reschedule|move|change).*(appointment)?/i.test(lower)) {
    const name = pickName(input.message);
    const phone = pickPhone(input.message);
    const historyId = "demo_reschedule_history";
    sendTool(input.res, { id: historyId, toolName: "fetch_patient_history", status: "started", label: "Looking up patient memory..." });
    const patient = clinicStore.findPatient({ patientId: input.patientId, name, contactPhone: phone });
    const snapshot = clinicStore.getSnapshot();
    const latestAppointment = patient
      ? [...patient.appointmentHistory].reverse().map((appointmentId) => snapshot.appointments[appointmentId]).find(Boolean)
      : undefined;
    sendTool(input.res, {
      id: historyId,
      toolName: "fetch_patient_history",
      status: "completed",
      label: patient ? `Found record for ${patient.name}` : "No existing record found",
      payload: { patient: patient ?? null, appointment: latestAppointment ?? null }
    });

    if (!patient || !latestAppointment) {
      const reply =
        "I can reschedule that, but I need the patient's full name or phone number tied to an existing appointment first.";
      await streamText(input.res, reply);
      return { reply };
    }

    const availabilityId = "demo_reschedule_availability";
    sendTool(input.res, { id: availabilityId, toolName: "check_doctor_availability", status: "started", label: "Checking replacement slots..." });
    const slots = clinicStore.checkAvailability({ preferredTime: preferredTime(input.message) });
    sendTool(input.res, {
      id: availabilityId,
      toolName: "check_doctor_availability",
      status: "completed",
      label: `Found ${slots.length} replacement slots`,
      payload: { slots }
    });

    const slot = slots[0];
    const rescheduleId = "demo_reschedule";
    sendTool(input.res, { id: rescheduleId, toolName: "reschedule_appointment", status: "started", label: "Rescheduling appointment..." });
    const appointment = clinicStore.rescheduleAppointment({
      patientId: patient.id,
      appointmentId: latestAppointment.id,
      doctorId: slot.doctorId,
      newStartTime: slot.startTime
    });
    const confirmation = clinicStore.sendConfirmation({
      patientId: patient.id,
      appointmentId: appointment.id,
      channel: "whatsapp",
      destination: patient.contactPhone
    });
    sendTool(input.res, {
      id: rescheduleId,
      toolName: "reschedule_appointment",
      status: "completed",
      label: "Appointment rescheduled and confirmation sent",
      payload: { appointment, patient, confirmation }
    });
    const reply = `Done, ${patient.name}. I moved your appointment to ${new Date(appointment.startTime).toLocaleString()} with ${appointment.doctorName}. Your confirmation reference is ${appointment.id}.`;
    await streamText(input.res, reply);
    return { reply, patientId: patient.id };
  }

  if (!/(book|appointment|available|availability|schedule|see a doctor)/i.test(lower)) {
    const reply = "I can help with appointments, availability, follow-ups, and recent visit history. What would you like to do today?";
    await streamText(input.res, reply);
    return { reply };
  }

  if (!/(i am|i'm|name is|this is)/i.test(input.message)) {
    const reply = "Of course. May I have your name, the main symptom or reason for the visit, and whether you prefer morning or afternoon?";
    await streamText(input.res, reply);
    return { reply };
  }

  const name = pickName(input.message);
  const symptoms = pickSymptoms(input.message);
  const phone = pickPhone(input.message);

  sendTool(input.res, {
    id: "demo_history",
    toolName: "fetch_patient_history",
    status: "started",
    label: "Looking up patient memory..."
  });
  const existingPatient = clinicStore.findPatient({ patientId: input.patientId, name, contactPhone: phone });
  sendTool(input.res, {
    id: "demo_history",
    toolName: "fetch_patient_history",
    status: "completed",
    label: existingPatient ? `Welcome back, ${existingPatient.name}` : "No existing record found",
    payload: { patient: existingPatient ?? null }
  });

  sendTool(input.res, {
    id: "demo_patient",
    toolName: "create_or_update_patient_record",
    status: "started",
    label: "Updating patient record..."
  });
  const patient = clinicStore.upsertPatient({
    patientId: input.patientId,
    name,
    contactPhone: phone,
    symptoms,
    note: "Demo booking intake"
  });
  sendTool(input.res, {
    id: "demo_patient",
    toolName: "create_or_update_patient_record",
    status: "completed",
    label: `Updated record for ${patient.name}`,
    payload: patient
  });

  sendTool(input.res, {
    id: "demo_active_bookings",
    toolName: "check_active_bookings",
    status: "started",
    label: "Checking active bookings..."
  });
  const activeBookings = clinicStore.getActiveBookings({ patientId: patient.id });
  sendTool(input.res, {
    id: "demo_active_bookings",
    toolName: "check_active_bookings",
    status: "completed",
    label: activeBookings.length > 0 ? "Active appointment found" : "No active appointment found",
    payload: { activeBookings, count: activeBookings.length }
  });
  if (activeBookings.length > 0) {
    const active = activeBookings[0];
    const reply = `I see you already have an appointment scheduled for ${formatAppointmentTime(active.startTime)}. Would you like me to reschedule or cancel that one instead?`;
    await streamText(input.res, reply);
    return { reply, patientId: patient.id };
  }

  sendTool(input.res, {
    id: "demo_availability",
    toolName: "check_doctor_availability",
    status: "started",
    label: "Checking availability..."
  });
  const slots = clinicStore.checkAvailability({ preferredTime: preferredTime(input.message) });
  sendTool(input.res, {
    id: "demo_availability",
    toolName: "check_doctor_availability",
    status: "completed",
    label: `Found ${slots.length} available slots`,
    payload: { slots }
  });

  if (slots.length === 0) {
    const reply = "I checked that exact time window and do not see an available slot. Would you like morning, afternoon, or evening instead?";
    await streamText(input.res, reply);
    return { reply, patientId: patient.id };
  }

  const slot = slots[0];
  sendTool(input.res, { id: "demo_book", toolName: "book_appointment", status: "started", label: "Booking appointment..." });
  const booking = clinicStore.bookAppointment({
    patientId: patient.id,
    patientName: patient.name,
    contactPhone: patient.contactPhone,
    symptoms,
    doctorId: slot.doctorId,
    startTime: slot.startTime
  });
  const confirmation = clinicStore.sendConfirmation({
    patientId: booking.patient.id,
    appointmentId: booking.appointment.id,
    channel: "whatsapp",
    destination: patient.contactPhone
  });
  sendTool(input.res, {
    id: "demo_book",
    toolName: "book_appointment",
    status: "completed",
    label: "Appointment booked and confirmation sent",
    payload: { ...booking, confirmation }
  });

  const when = new Date(booking.appointment.startTime).toLocaleString();
  const reply = `You are all set, ${booking.patient.name}. I booked you with ${booking.appointment.doctorName} for ${when} for ${symptoms}. Your WhatsApp confirmation has been sent with reference ${booking.appointment.id}.`;
  await streamText(input.res, reply);
  return { reply, patientId: booking.patient.id };
}

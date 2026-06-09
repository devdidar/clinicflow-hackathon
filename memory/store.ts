import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type {
  Appointment,
  ChatTurn,
  ClinicData,
  ConfirmationMessage,
  DoctorSlot,
  EmergencyCase,
  PatientRecord,
  SymptomEntry
} from "./types.js";

const dataDir = process.env.CLINICFLOW_DATA_DIR ?? (process.env.VERCEL ? path.join("/tmp", "clinicflow-ai") : path.join(process.cwd(), "memory", "data"));
const dataPath = path.join(dataDir, "clinicflow-store.json");

const doctorTemplates = [
  { doctorId: "dr-patel", doctorName: "Dr. Maya Patel", specialty: "Family Medicine" },
  { doctorId: "dr-khan", doctorName: "Dr. Arif Khan", specialty: "Internal Medicine" },
  { doctorId: "dr-chen", doctorName: "Dr. Lian Chen", specialty: "Urgent Care" }
];

const timeWindows = {
  morning: { startHour: 8, endHour: 12, hours: [8, 9, 10, 11] },
  afternoon: { startHour: 12, endHour: 17, hours: [12, 13, 14, 15, 16] },
  evening: { startHour: 17, endHour: 20, hours: [17, 18, 19] }
};

function emptyData(): ClinicData {
  return {
    patients: {},
    appointments: {},
    emergencies: [],
    confirmations: [],
    sessions: {},
    sessionProfiles: {}
  };
}

function ensureStore(): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataPath)) {
    fs.writeFileSync(dataPath, JSON.stringify(emptyData(), null, 2));
  }
}

function readData(): ClinicData {
  ensureStore();
  return { ...emptyData(), ...(JSON.parse(fs.readFileSync(dataPath, "utf8")) as Partial<ClinicData>) };
}

function writeData(data: ClinicData): void {
  ensureStore();
  const tmpPath = `${dataPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, dataPath);
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function localDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parsePreferredHour(preferredTime?: string): number | undefined {
  if (!preferredTime) return undefined;
  const match = preferredTime.toLowerCase().match(/(\d{1,2})(?::\d{2})?\s*(am|pm)?/);
  if (!match) return undefined;
  let hour = Number(match[1]);
  const meridiem = match[2];
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour;
}

function preferredHours(preferredTime?: string): number[] {
  const value = preferredTime?.toLowerCase() ?? "";
  if (value.includes("morning")) return timeWindows.morning.hours;
  if (value.includes("afternoon")) return timeWindows.afternoon.hours;
  if (value.includes("evening")) return timeWindows.evening.hours;

  const hour = parsePreferredHour(preferredTime);
  if (hour !== undefined) return [Math.min(Math.max(hour, 8), 19)];
  return [9, 10, 11, 14, 15, 16];
}

function withinRequestedTimeWindow(start: Date, end: Date, preferredTime?: string): boolean {
  const value = preferredTime?.toLowerCase() ?? "";
  const window = value.includes("morning")
    ? timeWindows.morning
    : value.includes("afternoon")
      ? timeWindows.afternoon
      : value.includes("evening")
        ? timeWindows.evening
        : undefined;

  if (!window) return true;
  const startHour = start.getHours() + start.getMinutes() / 60;
  const endHour = end.getHours() + end.getMinutes() / 60;
  return startHour >= window.startHour && endHour <= window.endHour;
}

function nextClinicDate(preferredDate?: string): Date {
  const base = preferredDate ? new Date(`${preferredDate}T09:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return new Date();
  base.setHours(9, 0, 0, 0);
  if (!preferredDate || base < new Date()) {
    base.setDate(base.getDate() + 1);
  }
  const day = base.getDay();
  if (day === 0) base.setDate(base.getDate() + 1);
  if (day === 6) base.setDate(base.getDate() + 2);
  return base;
}

function appointmentOverlaps(existing: Appointment, start: Date, end: Date, doctorId: string): boolean {
  if (existing.doctorId !== doctorId || existing.status === "cancelled") return false;
  const existingStart = new Date(existing.startTime);
  const existingEnd = new Date(existing.endTime);
  return start < existingEnd && end > existingStart;
}

export const clinicStore = {
  path: dataPath,

  resetForTests() {
    writeData(emptyData());
  },

  getSnapshot(): ClinicData {
    return readData();
  },

  getDashboard() {
    const data = readData();
    const appointments = Object.values(data.appointments).sort((a, b) => a.startTime.localeCompare(b.startTime));
    const patients = Object.values(data.patients).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      patientCount: Object.keys(data.patients).length,
      appointmentCount: appointments.length,
      emergencyCount: data.emergencies.length,
      confirmationCount: data.confirmations.length,
      appointments: appointments.slice(-20),
      emergencies: data.emergencies.slice(-10),
      confirmations: data.confirmations.slice(-10),
      patients: patients.slice(0, 10)
    };
  },

  appendSessionTurn(sessionId: string, turn: ChatTurn) {
    const data = readData();
    data.sessions[sessionId] = [...(data.sessions[sessionId] ?? []), turn].slice(-16);
    writeData(data);
  },

  getSessionTurns(sessionId: string): ChatTurn[] {
    return readData().sessions[sessionId] ?? [];
  },

  getSessionProfile(sessionId: string) {
    return readData().sessionProfiles[sessionId];
  },

  upsertSessionProfile(input: {
    sessionId: string;
    patientId?: string;
    phoneNumber?: string;
    patientName?: string;
  }) {
    const data = readData();
    const now = new Date().toISOString();
    const existing = data.sessionProfiles[input.sessionId];
    const profile = {
      sessionId: input.sessionId,
      patientId: input.patientId ?? existing?.patientId,
      phoneNumber: input.phoneNumber ?? existing?.phoneNumber,
      patientName: input.patientName ?? existing?.patientName,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    data.sessionProfiles[input.sessionId] = profile;
    writeData(data);
    return profile;
  },

  findPatient({ patientId, name, contactPhone }: { patientId?: string; name?: string; contactPhone?: string }) {
    const data = readData();
    if (patientId && data.patients[patientId]) return data.patients[patientId];
    return Object.values(data.patients).find((patient) => {
      const nameMatches = name ? normalize(patient.name) === normalize(name) : false;
      const phoneMatches = contactPhone && patient.contactPhone ? patient.contactPhone === contactPhone : false;
      return nameMatches || phoneMatches;
    });
  },

  getActiveBookings(input: { patientId?: string; patientName?: string; contactPhone?: string; date?: string }) {
    const data = readData();
    const patient = this.findPatient({
      patientId: input.patientId,
      name: input.patientName,
      contactPhone: input.contactPhone
    });
    if (!patient) return [];

    const dateKey = input.date ? localDateKey(input.date) : undefined;
    return patient.appointmentHistory
      .map((appointmentId) => data.appointments[appointmentId])
      .filter((appointment): appointment is Appointment => Boolean(appointment))
      .filter((appointment) => appointment.status === "scheduled" || appointment.status === "rescheduled")
      .filter((appointment) => !dateKey || localDateKey(appointment.startTime) === dateKey)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  },

  upsertPatient(input: {
    patientId?: string;
    name: string;
    contactPhone?: string;
    symptoms?: string;
    severity?: SymptomEntry["severity"];
    note?: string;
  }): PatientRecord {
    const data = readData();
    const now = new Date().toISOString();
    const existing = this.findPatient({
      patientId: input.patientId,
      name: input.name,
      contactPhone: input.contactPhone
    });

    const patient: PatientRecord = existing
      ? {
          ...existing,
          name: input.name || existing.name,
          contactPhone: input.contactPhone || existing.contactPhone,
          updatedAt: now
        }
      : {
          id: input.patientId || `pat_${nanoid(8)}`,
          name: input.name,
          contactPhone: input.contactPhone,
          symptomsHistory: [],
          appointmentHistory: [],
          notes: [],
          createdAt: now,
          updatedAt: now
        };

    if (input.symptoms) {
      patient.symptomsHistory = [
        ...patient.symptomsHistory,
        { symptom: input.symptoms, severity: input.severity, notedAt: now }
      ];
    }

    if (input.note) {
      patient.notes = [...patient.notes, input.note];
    }

    data.patients[patient.id] = patient;
    writeData(data);
    return patient;
  },

  checkAvailability(input: {
    preferredDate?: string;
    preferredTime?: string;
    symptomCategory?: string;
    urgency?: "routine" | "urgent";
  }): DoctorSlot[] {
    const data = readData();
    const date = nextClinicDate(input.preferredDate);
    const slots: DoctorSlot[] = [];

    for (let dayOffset = 0; dayOffset < 5 && slots.length < 8; dayOffset += 1) {
      const day = new Date(date);
      day.setDate(date.getDate() + dayOffset);
      if (day.getDay() === 0 || day.getDay() === 6) continue;

      const candidateHours = preferredHours(input.preferredTime);
      for (const doctor of doctorTemplates) {
        for (const hour of candidateHours) {
          const start = new Date(day);
          start.setHours(hour, doctor.doctorId === "dr-chen" ? 30 : 0, 0, 0);
          const end = addMinutes(start, input.urgency === "urgent" ? 20 : 30);
          if (!withinRequestedTimeWindow(start, end, input.preferredTime)) continue;
          const taken = Object.values(data.appointments).some((appointment) =>
            appointmentOverlaps(appointment, start, end, doctor.doctorId)
          );
          if (!taken) {
            slots.push({
              ...doctor,
              startTime: start.toISOString(),
              endTime: end.toISOString(),
              priority: doctor.doctorId === "dr-chen" ? "urgent" : "routine"
            });
          }
          if (slots.length >= 8) break;
        }
        if (slots.length >= 8) break;
      }
    }

    return slots;
  },

  bookAppointment(input: {
    patientId?: string;
    patientName: string;
    contactPhone?: string;
    symptoms: string;
    doctorId: string;
    startTime: string;
  }) {
    const requestedStart = new Date(input.startTime);
    const exactPreferredTime = `${requestedStart.getHours()}:${String(requestedStart.getMinutes()).padStart(2, "0")}`;
    const slots = this.checkAvailability({ preferredDate: localDateKey(requestedStart), preferredTime: exactPreferredTime });
    const selectedSlot =
      slots.find((slot) => slot.doctorId === input.doctorId && Math.abs(new Date(slot.startTime).getTime() - requestedStart.getTime()) < 60_000) ??
      null;

    if (!selectedSlot) {
      throw new Error("Requested appointment slot is no longer available.");
    }

    const data = readData();
    const patient = this.upsertPatient({
      patientId: input.patientId,
      name: input.patientName,
      contactPhone: input.contactPhone,
      symptoms: input.symptoms,
      note: `Booked for ${input.symptoms}`
    });
    const activeBookings = this.getActiveBookings({ patientId: patient.id, date: selectedSlot.startTime });
    if (activeBookings.length > 0) {
      throw new Error(`ACTIVE_BOOKING_EXISTS:${activeBookings[0].id}`);
    }
    const now = new Date().toISOString();
    const appointment: Appointment = {
      id: `apt_${nanoid(8)}`,
      patientId: patient.id,
      doctorId: selectedSlot.doctorId,
      doctorName: selectedSlot.doctorName,
      startTime: selectedSlot.startTime,
      endTime: selectedSlot.endTime,
      symptoms: input.symptoms,
      status: "scheduled",
      createdAt: now,
      updatedAt: now
    };

    const freshData = readData();
    freshData.appointments[appointment.id] = appointment;
    freshData.patients[patient.id] = {
      ...patient,
      appointmentHistory: [...patient.appointmentHistory, appointment.id],
      lastSeenAt: appointment.startTime,
      updatedAt: now
    };
    writeData(freshData);
    return { appointment, patient: freshData.patients[patient.id] };
  },

  rescheduleAppointment(input: { patientId: string; appointmentId: string; doctorId?: string; newStartTime: string }) {
    const data = readData();
    const appointment = data.appointments[input.appointmentId];
    if (!appointment || appointment.patientId !== input.patientId) {
      throw new Error("Appointment not found for this patient.");
    }

    const requestedStart = new Date(input.newStartTime);
    const exactPreferredTime = `${requestedStart.getHours()}:${String(requestedStart.getMinutes()).padStart(2, "0")}`;
    const slots = this.checkAvailability({ preferredDate: localDateKey(requestedStart), preferredTime: exactPreferredTime });
    const doctorId = input.doctorId ?? appointment.doctorId;
    const selectedSlot =
      slots.find((slot) => slot.doctorId === doctorId && Math.abs(new Date(slot.startTime).getTime() - requestedStart.getTime()) < 60_000) ??
      slots.find((slot) => slot.doctorId === doctorId) ??
      slots[0];
    if (!selectedSlot) throw new Error("No replacement slots are available.");

    const updated = {
      ...appointment,
      doctorId: selectedSlot.doctorId,
      doctorName: selectedSlot.doctorName,
      startTime: selectedSlot.startTime,
      endTime: selectedSlot.endTime,
      status: "rescheduled" as const,
      updatedAt: new Date().toISOString()
    };
    data.appointments[input.appointmentId] = updated;
    writeData(data);
    return updated;
  },

  sendConfirmation(input: { patientId: string; appointmentId: string; channel: ConfirmationMessage["channel"]; destination?: string }) {
    const data = readData();
    const patient = data.patients[input.patientId];
    const appointment = data.appointments[input.appointmentId];
    if (!patient || !appointment) throw new Error("Patient or appointment was not found.");

    const confirmation: ConfirmationMessage = {
      id: `msg_${nanoid(8)}`,
      patientId: patient.id,
      appointmentId: appointment.id,
      channel: input.channel,
      destination: input.destination || patient.contactPhone || "demo-whatsapp",
      body: `ClinicFlow AI confirmation: ${patient.name} is booked with ${appointment.doctorName} on ${new Date(
        appointment.startTime
      ).toLocaleString()}. Reference ${appointment.id}.`,
      sentAt: new Date().toISOString(),
      status: "sent"
    };

    data.confirmations.push(confirmation);
    data.appointments[appointment.id] = { ...appointment, confirmationId: confirmation.id };
    writeData(data);
    return confirmation;
  },

  flagEmergency(input: {
    patientId?: string;
    patientName?: string;
    symptoms: string;
    severity: "high" | "emergency";
    reason: string;
  }): EmergencyCase {
    const data = readData();
    const emergency: EmergencyCase = {
      id: `emg_${nanoid(8)}`,
      patientId: input.patientId,
      patientName: input.patientName,
      symptoms: input.symptoms,
      severity: input.severity,
      reason: input.reason,
      flaggedAt: new Date().toISOString(),
      status: "flagged"
    };
    data.emergencies.push(emergency);
    writeData(data);
    return emergency;
  }
};

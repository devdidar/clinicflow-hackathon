export type AppointmentStatus = "scheduled" | "rescheduled" | "cancelled";
export type WorkflowState =
  | "INTAKE"
  | "SESSION_ROUTING"
  | "COLLECT_INFO"
  | "CHECK_AVAILABILITY"
  | "CHECK_ACTIVE_BOOKINGS"
  | "BOOK_APPOINTMENT"
  | "RESCHEDULE_APPOINTMENT"
  | "CONFIRMATION"
  | "MEMORY_LOOKUP"
  | "EMERGENCY_ROUTING"
  | "FAILURE_RECOVERY";

export interface DoctorSchedule {
  doctorId: string;
  doctorName: string;
  specialty: string;
  availableSlots: DoctorSlot[];
}

export interface SymptomEntry {
  symptom: string;
  severity?: "low" | "medium" | "high" | "emergency";
  notedAt: string;
}

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName: string;
  startTime: string;
  endTime: string;
  symptoms: string;
  status: AppointmentStatus;
  confirmationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PatientRecord {
  id: string;
  name: string;
  contactPhone?: string;
  lastSeenAt?: string;
  symptomsHistory: SymptomEntry[];
  appointmentHistory: string[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DoctorSlot {
  doctorId: string;
  doctorName: string;
  specialty: string;
  startTime: string;
  endTime: string;
  priority?: "routine" | "urgent";
}

export interface EmergencyCase {
  id: string;
  patientId?: string;
  patientName?: string;
  symptoms: string;
  severity: "high" | "emergency";
  reason: string;
  flaggedAt: string;
  status: "flagged" | "triaged";
}

export interface ConfirmationMessage {
  id: string;
  patientId: string;
  appointmentId: string;
  channel: "whatsapp" | "email" | "sms";
  destination: string;
  body: string;
  sentAt: string;
  status: "sent" | "failed";
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface SessionProfile {
  sessionId: string;
  patientId?: string;
  phoneNumber?: string;
  patientName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClinicData {
  patients: Record<string, PatientRecord>;
  appointments: Record<string, Appointment>;
  emergencies: EmergencyCase[];
  confirmations: ConfirmationMessage[];
  sessions: Record<string, ChatTurn[]>;
  sessionProfiles: Record<string, SessionProfile>;
}

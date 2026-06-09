import { nanoid } from "nanoid";
import { clinicStore } from "../../memory/store.js";

export interface SessionRoutingInput {
  sessionId: string;
  patientId?: string;
  phoneNumber?: string;
  message: string;
}

export interface SessionRoutingResult {
  sessionId: string;
  previousSessionId: string;
  switched: boolean;
  reason?: "phone_mismatch";
  phoneNumber?: string;
  patientName?: string;
  claimedName?: string;
  patientId?: string;
  identityConflict?: boolean;
  invalidPhone?: string;
}

export function normalizePhone(phone?: string): string | undefined {
  const cleaned = phone?.replace(/[^\d+]/g, "");
  if (!cleaned) return undefined;
  const digits = cleaned.replace(/[^\d]/g, "");
  let normalized: string | undefined;

  if (cleaned.startsWith("+880")) {
    normalized = `+${digits}`;
  } else if (digits.startsWith("880")) {
    normalized = `+${digits}`;
  } else if (digits.startsWith("01") && digits.length === 11) {
    normalized = `+880${digits.slice(1)}`;
  }

  return normalized && /^\+8801[3-9]\d{8}$/.test(normalized) ? normalized : undefined;
}

export function extractPhone(message: string): string | undefined {
  return normalizePhone(message.match(/(\+?\d[\d\s-]{5,}\d)/)?.[1]);
}

export function extractClaimedName(message: string): string | undefined {
  return message
    .match(/(?:i am|i'm|name is|this is)\s+([a-z][a-z\s'-]{1,40}?)(?:[,.!?]|\s+(?:and|with|for|because|please)\b|$)/i)?.[1]
    ?.trim();
}

function sameName(a?: string, b?: string): boolean {
  if (!a || !b) return true;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function resolveIncomingSession(input: SessionRoutingInput): SessionRoutingResult {
  const invalidPhone = input.phoneNumber && !normalizePhone(input.phoneNumber) ? input.phoneNumber : undefined;
  const incomingPhone = normalizePhone(input.phoneNumber);
  const incomingName = extractClaimedName(input.message);
  const current = clinicStore.getSessionProfile(input.sessionId);
  const phoneMismatch = Boolean(incomingPhone && current?.phoneNumber && incomingPhone !== current.phoneNumber);
  const switched = phoneMismatch;
  const sessionId = switched ? `session_${nanoid(8)}` : input.sessionId;
  const patient = clinicStore.findPatient({
    patientId: switched ? undefined : input.patientId ?? current?.patientId,
    contactPhone: incomingPhone
  });
  const verifiedPatientName = patient?.name ?? (switched ? undefined : current?.patientName);
  const identityConflict = Boolean(incomingName && verifiedPatientName && !sameName(incomingName, verifiedPatientName));

  clinicStore.upsertSessionProfile({
    sessionId,
    patientId: patient?.id ?? (switched ? undefined : input.patientId ?? current?.patientId),
    phoneNumber: incomingPhone ?? (switched ? undefined : current?.phoneNumber),
    patientName: verifiedPatientName
  });

  return {
    sessionId,
    previousSessionId: input.sessionId,
    switched,
    reason: phoneMismatch ? "phone_mismatch" : undefined,
    phoneNumber: incomingPhone ?? current?.phoneNumber,
    patientName: verifiedPatientName,
    claimedName: incomingName,
    patientId: patient?.id ?? (switched ? undefined : input.patientId ?? current?.patientId),
    identityConflict,
    invalidPhone
  };
}

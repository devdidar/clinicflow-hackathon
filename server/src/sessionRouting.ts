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
  reason?: "phone_mismatch" | "identity_mismatch";
  phoneNumber?: string;
  patientName?: string;
  patientId?: string;
}

export function normalizePhone(phone?: string): string | undefined {
  const digits = phone?.replace(/[^\d+]/g, "");
  return digits || undefined;
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
  const incomingPhone = normalizePhone(input.phoneNumber) ?? extractPhone(input.message);
  const incomingName = extractClaimedName(input.message);
  const current = clinicStore.getSessionProfile(input.sessionId);
  const phoneMismatch = Boolean(incomingPhone && current?.phoneNumber && incomingPhone !== current.phoneNumber);
  const identityMismatch = Boolean(incomingName && current?.patientName && !sameName(incomingName, current.patientName));
  const switched = phoneMismatch || identityMismatch;
  const sessionId = switched ? `session_${nanoid(8)}` : input.sessionId;
  const patient = clinicStore.findPatient({
    patientId: switched ? undefined : input.patientId ?? current?.patientId,
    name: incomingName,
    contactPhone: incomingPhone
  });

  clinicStore.upsertSessionProfile({
    sessionId,
    patientId: patient?.id ?? (switched ? undefined : input.patientId ?? current?.patientId),
    phoneNumber: incomingPhone ?? (switched ? undefined : current?.phoneNumber),
    patientName: incomingName ?? patient?.name ?? (switched ? undefined : current?.patientName)
  });

  return {
    sessionId,
    previousSessionId: input.sessionId,
    switched,
    reason: phoneMismatch ? "phone_mismatch" : identityMismatch ? "identity_mismatch" : undefined,
    phoneNumber: incomingPhone ?? current?.phoneNumber,
    patientName: incomingName ?? patient?.name ?? current?.patientName,
    patientId: patient?.id ?? (switched ? undefined : input.patientId ?? current?.patientId)
  };
}

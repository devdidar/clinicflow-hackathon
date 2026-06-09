export function formatIdentityConflictLog(input: { claimedName?: string; verifiedName?: string }) {
  return `[IDENTITY CONFLICT DETECTED: Sender claims to be ${input.claimedName ?? "unknown"} from ${input.verifiedName ?? "another patient's"} device]`;
}

export function formatIdentityConflictEmergencyReply(input: { verifiedName?: string }) {
  return `If you are having chest pain, trouble breathing, stroke symptoms, severe bleeding, or feel unsafe, please call emergency services or go to the nearest ER now. I am alerting our clinic staff right away so they can follow up. Because this message came from an account registered to ${input.verifiedName ?? "another patient"}, our triage team will quickly verify your details when they contact you.`;
}

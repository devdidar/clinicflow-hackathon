import { beforeEach, describe, expect, it } from "vitest";
import type { Response } from "express";
import { clinicStore } from "../memory/store.js";
import { runDemoReceptionist } from "../server/src/demoAgent.js";
import { resolveIncomingSession } from "../server/src/sessionRouting.js";
import { formatIdentityConflictEmergencyReply, formatIdentityConflictLog } from "../server/src/identityConflict.js";

function parseEvents(payload: string) {
  return payload
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? "message";
      const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? "{}");
      return { event, data };
    });
}

function createMockSseResponse() {
  const chunks: string[] = [];
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => res
  } as unknown as Response;

  return {
    res,
    text: () => chunks.join("")
  };
}

async function demoStream(message: string, sessionId = "test-session") {
  const mock = createMockSseResponse();
  const result = await runDemoReceptionist({ res: mock.res, sessionId, message });
  return { result, events: parseEvents(mock.text()) };
}

function toolPayload<T>(events: ReturnType<typeof parseEvents>, toolName: string): T | undefined {
  return events.find((item) => item.event === "tool" && item.data.toolName === toolName && item.data.status === "completed")?.data.payload;
}

beforeEach(() => {
  process.env.CLINICFLOW_DEMO_MODE = "1";
  clinicStore.resetForTests();
});

describe("ClinicFlow AI integration", () => {
  it("streams a booking flow, executes tools, and persists memory", async () => {
    const { events, result } = await demoStream(
      "Hi, I'm Didarul Azam and I need to book an afternoon appointment for fever. My phone is +8801712345678."
    );

    expect(events.some((item) => item.event === "delta")).toBe(true);
    expect(events.some((item) => item.event === "tool" && item.data.toolName === "check_doctor_availability")).toBe(true);
    expect(events.some((item) => item.event === "tool" && item.data.toolName === "book_appointment")).toBe(true);
    expect(result.patientId).toMatch(/^pat_/);

    const dashboard = clinicStore.getDashboard();
    expect(dashboard.appointmentCount).toBe(1);
    expect(dashboard.confirmationCount).toBe(1);

    const patient = clinicStore.findPatient({ patientId: result.patientId });
    expect(patient?.name).toBe("Didarul Azam");
    expect(patient?.symptomsHistory.at(-1)?.symptom).toContain("fever");
    expect(new Date(dashboard.appointments[0].startTime).getHours()).toBeGreaterThanOrEqual(12);
    expect(new Date(dashboard.appointments[0].startTime).getHours()).toBeLessThan(17);
  });

  it("answers availability without hallucinating a booking", async () => {
    const { events } = await demoStream("What afternoon appointment slots are available tomorrow?");
    const availability = toolPayload<{ slots: Array<{ startTime: string }> }>(events, "check_doctor_availability");

    expect(events.some((item) => item.event === "tool" && item.data.toolName === "check_doctor_availability")).toBe(true);
    expect(events.some((item) => item.event === "tool" && item.data.toolName === "book_appointment")).toBe(false);
    expect(availability?.slots.length).toBeGreaterThan(0);
    expect(availability?.slots.every((slot) => {
      const hour = new Date(slot.startTime).getHours();
      return hour >= 12 && hour < 17;
    })).toBe(true);
    expect(clinicStore.getDashboard().appointmentCount).toBe(0);
  });

  it("does not create a duplicate booking when the patient repeats the same request", async () => {
    await demoStream("Hi, I'm Didarul Azam and I need to book an afternoon appointment for fever. My phone is +8801712345678.");
    const { events } = await demoStream("Hi, I'm Didarul Azam and I need to book an afternoon appointment for fever. My phone is +8801712345678.");
    const streamedText = events.filter((item) => item.event === "delta").map((item) => item.data.text).join("");

    expect(events.some((item) => item.event === "tool" && item.data.toolName === "check_active_bookings")).toBe(true);
    expect(events.some((item) => item.event === "tool" && item.data.toolName === "book_appointment")).toBe(false);
    expect(streamedText).toMatch(/already have an appointment|reschedule or cancel/i);
    expect(clinicStore.getDashboard().appointmentCount).toBe(1);
  });

  it("reschedules an existing appointment through lookup and reschedule tools", async () => {
    const booking = await demoStream(
      "Hi, I'm Didarul Azam and I need to book a morning appointment for fever. My phone is +8801712345678."
    );
    const originalAppointment = clinicStore.getDashboard().appointments[0];

    const { events } = await demoStream("This is Didarul Azam. Please reschedule my appointment to the afternoon.");

    expect(booking.result.patientId).toMatch(/^pat_/);
    expect(events.some((item) => item.event === "tool" && item.data.toolName === "fetch_patient_history")).toBe(true);
    expect(events.some((item) => item.event === "tool" && item.data.toolName === "check_doctor_availability")).toBe(true);
    expect(events.some((item) => item.event === "tool" && item.data.toolName === "reschedule_appointment")).toBe(true);

    const dashboard = clinicStore.getDashboard();
    expect(dashboard.appointmentCount).toBe(1);
    expect(dashboard.confirmationCount).toBe(2);
    expect(dashboard.appointments[0].id).toBe(originalAppointment.id);
    expect(dashboard.appointments[0].status).toBe("rescheduled");
  });

  it("looks up returning patient memory before personalizing", async () => {
    await demoStream("Hi, I'm Didarul Azam and I need to book an afternoon appointment for fever. My phone is +8801712345678.");
    const { events } = await demoStream("This is Didarul Azam. Can you check my previous visit history?");

    expect(events.some((item) => item.event === "tool" && item.data.toolName === "fetch_patient_history")).toBe(true);
    expect(events.some((item) => item.event === "delta" && /Welcome back|found/i.test(item.data.text))).toBe(true);
  });

  it("flags emergency symptoms instead of normal booking", async () => {
    const { events } = await demoStream("This is Omar Rahman. I have chest pain and shortness of breath.");

    expect(events.some((item) => item.event === "tool" && item.data.toolName === "flag_emergency_case")).toBe(true);
    expect(events.some((item) => item.event === "delta" && /emergency|ER|urgent/i.test(item.data.text))).toBe(true);

    const dashboard = clinicStore.getDashboard();
    expect(dashboard.emergencyCount).toBe(1);
    expect(dashboard.appointmentCount).toBe(0);
  });

  it("creates a fresh session when sender phone changes on the same gateway session", async () => {
    const sara = clinicStore.upsertPatient({ name: "Didarul Azam", contactPhone: "+8801712345678" });
    clinicStore.upsertSessionProfile({
      sessionId: "gateway-thread",
      patientId: sara.id,
      patientName: "Didarul Azam",
      phoneNumber: "+8801712345678"
    });
    clinicStore.appendSessionTurn("gateway-thread", {
      role: "user",
      content: "Hi, I'm Didarul Azam and my phone is +8801712345678.",
      createdAt: new Date().toISOString()
    });

    const route = resolveIncomingSession({
      sessionId: "gateway-thread",
      phoneNumber: "+8801812345678",
      message: "This is Omar Rahman. I have chest pain."
    });

    expect(route.switched).toBe(true);
    expect(route.reason).toBe("phone_mismatch");
    expect(route.sessionId).not.toBe("gateway-thread");
    expect(clinicStore.getSessionProfile("gateway-thread")?.patientName).toBe("Didarul Azam");
    expect(route.claimedName).toBe("Omar Rahman");
    expect(clinicStore.getSessionProfile(route.sessionId)?.phoneNumber).toBe("+8801812345678");
    expect(clinicStore.getSessionProfile(route.sessionId)?.patientName).toBeUndefined();
    expect(clinicStore.getSessionTurns(route.sessionId)).toHaveLength(0);
    expect(clinicStore.getSessionTurns("gateway-thread")[0].content).toContain("Didarul Azam");
  });

  it("does not switch profiles from text-only identity conflict on the same phone session", async () => {
    clinicStore.upsertSessionProfile({
      sessionId: "shared-browser",
      patientName: "Didarul Azam",
      phoneNumber: "+8801712345678"
    });

    const route = resolveIncomingSession({
      sessionId: "shared-browser",
      message: "This is Omar Rahman. Can I book an afternoon appointment?"
    });

    expect(route.switched).toBe(false);
    expect(route.identityConflict).toBe(true);
    expect(route.sessionId).toBe("shared-browser");
    expect(route.claimedName).toBe("Omar Rahman");
    expect(clinicStore.getSessionProfile(route.sessionId)?.patientName).toBe("Didarul Azam");
  });

  it("normalizes Bangladesh phone metadata and rejects invalid numbers", async () => {
    const localRoute = resolveIncomingSession({
      sessionId: "bd-phone",
      phoneNumber: "01712345678",
      message: "Hi, I'm Didarul Azam."
    });
    const missingPlusRoute = resolveIncomingSession({
      sessionId: "bd-phone-2",
      phoneNumber: "8801812345678",
      message: "Hi."
    });
    const invalidRoute = resolveIncomingSession({
      sessionId: "bad-phone",
      phoneNumber: "555-0199",
      message: "Hi."
    });

    expect(localRoute.phoneNumber).toBe("+8801712345678");
    expect(missingPlusRoute.phoneNumber).toBe("+8801812345678");
    expect(invalidRoute.invalidPhone).toBe("555-0199");
  });

  it("keeps identity conflict logs internal while sending supportive emergency triage text", async () => {
    const mock = createMockSseResponse();
    const result = await runDemoReceptionist({
      res: mock.res,
      sessionId: "conflict-session",
      patientId: "pat_verified",
      message: "This is Omar Rahman. I have chest pain and shortness of breath.",
      identityConflict: { claimedName: "Omar Rahman", verifiedName: "Didarul Azam" }
    });
    const events = parseEvents(mock.text());
    const streamedText = events.filter((item) => item.event === "delta").map((item) => item.data.text).join("");

    expect(formatIdentityConflictLog({ claimedName: "Omar Rahman", verifiedName: "Didarul Azam" })).toBe(
      "[IDENTITY CONFLICT DETECTED: Sender claims to be Omar Rahman from Didarul Azam device]"
    );
    expect(result.reply).toBe(formatIdentityConflictEmergencyReply({ verifiedName: "Didarul Azam" }));
    expect(streamedText).not.toContain("[IDENTITY CONFLICT DETECTED");
    expect(streamedText).toContain("please call emergency services or go to the nearest ER now");
    expect(streamedText).toContain("I am alerting our clinic staff right away");
    expect(streamedText).toContain("registered to Didarul Azam");
  });
});

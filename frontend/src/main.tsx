import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  CalendarCheck,
  CheckCircle2,
  Clock,
  Loader2,
  Mic,
  Phone,
  RefreshCw,
  Send,
  ShieldAlert,
  Stethoscope,
  UserRound
} from "lucide-react";
import "./styles.css";

type Role = "patient" | "assistant";

interface Message {
  id: string;
  role: Role;
  text: string;
}

interface ToolEvent {
  id: string;
  toolName: string;
  status: "started" | "completed" | "failed";
  label: string;
  payload?: unknown;
}

interface Appointment {
  id: string;
  patientId: string;
  doctorName: string;
  startTime: string;
  symptoms: string;
  status: string;
}

interface SymptomEntry {
  symptom: string;
  notedAt: string;
  severity?: string;
}

interface PatientSummary {
  id: string;
  name: string;
  contactPhone?: string;
  lastSeenAt?: string;
  symptomsHistory: SymptomEntry[];
  appointmentHistory: string[];
  updatedAt: string;
}

interface Confirmation {
  id: string;
  appointmentId: string;
  channel: string;
  destination: string;
  body: string;
  sentAt: string;
  status: string;
}

interface Dashboard {
  patientCount: number;
  appointmentCount: number;
  emergencyCount: number;
  confirmationCount: number;
  appointments: Appointment[];
  emergencies: Array<{ id: string; symptoms: string; severity: string; flaggedAt: string }>;
  confirmations: Confirmation[];
  patients: PatientSummary[];
}

const API_BASE = import.meta.env.VITE_API_BASE ?? (import.meta.env.DEV ? "http://localhost:8787" : "");

function id() {
  return Math.random().toString(36).slice(2);
}

function extractPhone(text: string): string | undefined {
  const raw = text.match(/(\+?\d[\d\s-]{5,}\d)/)?.[1]?.replace(/[^\d+]/g, "");
  if (!raw) return undefined;
  const digits = raw.replace(/[^\d]/g, "");
  if (raw.startsWith("+880")) return `+${digits}`;
  if (digits.startsWith("880")) return `+${digits}`;
  if (digits.startsWith("01") && digits.length === 11) return `+880${digits.slice(1)}`;
  return undefined;
}

function extractName(text: string): string | undefined {
  return text
    .match(/(?:i am|i'm|name is|this is)\s+([a-z][a-z\s'-]{1,40}?)(?:[,.!?]|\s+(?:and|with|for|because|please)\b|$)/i)?.[1]
    ?.trim();
}

function parseSse(buffer: string) {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? "message";
      const dataRaw = block.match(/^data: (.+)$/m)?.[1] ?? "{}";
      return { event, data: JSON.parse(dataRaw) };
    })
    .filter(Boolean);
  return { events, rest };
}

function lastBookingFromTool(event?: ToolEvent): Appointment | null {
  const payload = event?.payload as
    | { appointment?: Appointment; booking?: { appointment?: Appointment }; confirmation?: unknown }
    | undefined;
  return payload?.appointment ?? payload?.booking?.appointment ?? null;
}

function lastConfirmationFromTool(event?: ToolEvent): Confirmation | null {
  const payload = event?.payload as { confirmation?: Confirmation } | undefined;
  return payload?.confirmation ?? null;
}

const workflowActions = [
  {
    label: "Book",
    prompt: "Hi, I'm Didarul Azam and I need to book an afternoon appointment for fever. My phone is +8801712345678."
  },
  {
    label: "Availability",
    prompt: "What afternoon appointment slots are available tomorrow?"
  },
  {
    label: "Memory",
    prompt: "This is Didarul Azam. Can you check my previous visit history?"
  },
  {
    label: "Reschedule",
    prompt: "This is Didarul Azam. Please reschedule my appointment to the afternoon."
  },
  {
    label: "Emergency",
    prompt: "This is Omar Rahman. I have chest pain and shortness of breath."
  }
];

function App() {
  const [sessionId, setSessionId] = useState(() => `session_${id()}`);
  const [patientId, setPatientId] = useState<string | undefined>();
  const [activePhone, setActivePhone] = useState<string | undefined>();
  const [activeName, setActiveName] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: id(),
      role: "assistant",
      text: "Good afternoon, ClinicFlow front desk. How can I help today?"
    }
  ]);
  const [input, setInput] = useState("Hi, I'm Didarul Azam and I need to book an afternoon appointment for fever. My phone is +8801712345678.");
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [listening, setListening] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [patientMemory, setPatientMemory] = useState<{ patient: PatientSummary; appointments: Appointment[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  function clearPatientViewport(nextGreeting = "New sender detected. ClinicFlow opened a fresh patient session.") {
    setMessages([{ id: id(), role: "assistant", text: nextGreeting }]);
    setToolEvents([]);
    setPatientId(undefined);
    setPatientMemory(null);
    setError(null);
  }

  const latestBooking = useMemo(() => {
    const bookingEvent = [...toolEvents].reverse().find((event) => event.toolName === "book_appointment" && event.status === "completed");
    return lastBookingFromTool(bookingEvent);
  }, [toolEvents]);

  const latestConfirmation = useMemo(() => {
    const confirmationEvent = [...toolEvents]
      .reverse()
      .find((event) => event.status === "completed" && lastConfirmationFromTool(event));
    return lastConfirmationFromTool(confirmationEvent);
  }, [toolEvents]);

  const intakeStatus = useMemo(() => {
    const patient = patientMemory?.patient;
    const hasHistoryLookup = toolEvents.some((event) => event.toolName === "fetch_patient_history" && event.status === "completed");
    const hasAvailability = toolEvents.some((event) => event.toolName === "check_doctor_availability" && event.status === "completed");
    const hasActionTool = toolEvents.some(
      (event) =>
        (event.toolName === "book_appointment" || event.toolName === "reschedule_appointment" || event.toolName === "flag_emergency_case") &&
        event.status === "completed"
    );

    return [
      { label: "Patient identified", done: Boolean(patient?.name), detail: patient?.name ?? "Waiting" },
      {
        label: "Problem captured",
        done: Boolean(latestBooking?.symptoms || patient?.symptomsHistory?.at(-1)?.symptom),
        detail: latestBooking?.symptoms ?? patient?.symptomsHistory?.at(-1)?.symptom ?? "Waiting"
      },
      { label: "Memory checked", done: hasHistoryLookup, detail: hasHistoryLookup ? "Tool verified" : "Required before personalization" },
      { label: "Availability checked", done: hasAvailability, detail: hasAvailability ? "Slots returned" : "Required before booking" },
      { label: "Action completed", done: hasActionTool, detail: hasActionTool ? "Tool result received" : "No confirmation yet" },
      { label: "Notification sent", done: Boolean(latestConfirmation), detail: latestConfirmation?.destination ?? "Waiting" }
    ];
  }, [latestBooking, latestConfirmation, patientMemory, toolEvents]);

  async function refreshDashboard() {
    const response = await fetch(`${API_BASE}/api/dashboard`);
    setDashboard(await response.json());
  }

  useEffect(() => {
    refreshDashboard().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!patientId) return;
    fetch(`${API_BASE}/api/memory/${patientId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.patient) setPatientMemory({ patient: data.patient, appointments: data.appointments ?? [] });
      })
      .catch(() => undefined);
  }, [patientId, dashboard?.appointmentCount]);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, toolEvents]);

  async function sendMessage(override?: string) {
    const text = (override ?? input).trim();
    if (!text || isStreaming) return;
    const incomingPhone = extractPhone(text);
    const incomingName = extractName(text);
    const localMismatch = Boolean(incomingPhone && activePhone && incomingPhone !== activePhone);
    const requestSessionId = localMismatch ? `session_${id()}` : sessionId;
    if (localMismatch) {
      setSessionId(requestSessionId);
      setActivePhone(incomingPhone);
      setActiveName(incomingName);
      clearPatientViewport("New sender detected. I cleared the previous patient context and opened a fresh session.");
    }
    setError(null);
    setInput("");
    setMessages((current) => [...current, { id: id(), role: "patient", text }, { id: "streaming", role: "assistant", text: "" }]);
    setIsStreaming(true);

    try {
      const response = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, sessionId: requestSessionId, patientId: localMismatch ? undefined : patientId, phoneNumber: incomingPhone ?? activePhone })
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed with ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;

        for (const item of parsed.events) {
          if (item.event === "delta") {
            setMessages((current) =>
              current.map((message) =>
                message.id === "streaming" ? { ...message, text: `${message.text}${item.data.text}` } : message
              )
            );
          }
          if (item.event === "tool") {
            setToolEvents((current) => {
              const index = current.findIndex((event) => event.id === item.data.id);
              if (index === -1) return [...current, item.data];
              return current.map((event) => (event.id === item.data.id ? item.data : event));
            });
          }
          if (item.event === "session_switch") {
            setSessionId(item.data.sessionId);
            setActivePhone(item.data.phoneNumber);
            setActiveName(item.data.patientName);
            setPatientId(item.data.patientId);
            setPatientMemory(null);
            setToolEvents([]);
            setMessages([{ id: id(), role: "patient", text }, { id: "streaming", role: "assistant", text: "" }]);
          }
          if (item.event === "identity_conflict") {
            setToolEvents((current) => [
              ...current,
              {
                id: `identity_conflict_${id()}`,
                toolName: "identity_conflict",
                status: "completed",
                label: item.data.message,
                payload: item.data
              }
            ]);
          }
          if (item.event === "done") {
            setPatientId(item.data.patientId ?? patientId);
            setSessionId(item.data.sessionId ?? requestSessionId);
            setActivePhone(item.data.phoneNumber ?? incomingPhone ?? activePhone);
            setActiveName(item.data.patientName ?? activeName);
          }
          if (item.event === "error") {
            throw new Error(item.data.error);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setMessages((current) =>
        current.map((message) =>
          message.id === "streaming"
            ? { ...message, text: "I'm sorry, the front desk system hit an error while processing that request." }
            : message
        )
      );
    } finally {
      setMessages((current) => current.map((message) => (message.id === "streaming" ? { ...message, id: id() } : message)));
      setIsStreaming(false);
      refreshDashboard().catch(() => undefined);
    }
  }

  function simulateVoice() {
    setListening(true);
    setTimeout(() => {
      setInput("This is Omar Rahman. I have chest pain and shortness of breath.");
      setListening(false);
    }, 900);
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="sidebar">
          <div className="brand-block">
            <div className="brand-mark">
              <Stethoscope size={22} />
            </div>
            <div>
              <h1>ClinicFlow AI</h1>
              <p>Northside Family Clinic</p>
            </div>
          </div>

          <div className="queue-panel">
            <div className="metric-row">
              <span>Patients</span>
              <strong>{dashboard?.patientCount ?? 0}</strong>
            </div>
            <div className="metric-row">
              <span>Bookings</span>
              <strong>{dashboard?.appointmentCount ?? 0}</strong>
            </div>
            <div className="metric-row urgent">
              <span>Urgent flags</span>
              <strong>{dashboard?.emergencyCount ?? 0}</strong>
            </div>
            <button className="icon-button wide" onClick={refreshDashboard} title="Refresh dashboard">
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>

          <div className="tool-panel">
            <div className="panel-title">
              <Activity size={16} />
              Live tools
            </div>
            <div className="tool-list">
              {toolEvents.length === 0 ? <span className="muted">No tool activity yet</span> : null}
              {toolEvents.slice(-8).map((event) => (
                <div className={`tool-chip ${event.status}`} key={event.id}>
                  {event.status === "started" ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
                  <span>{event.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="tool-panel">
            <div className="panel-title">
              <CheckCircle2 size={16} />
              Intake checklist
            </div>
            <div className="check-list">
              {intakeStatus.map((item) => (
                <div className={`check-row ${item.done ? "done" : ""}`} key={item.label}>
                  <CheckCircle2 size={15} />
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>

        <section className="conversation">
          <header className="chat-header">
            <div>
              <span className="eyebrow">Reception desk</span>
              <h2>Patient intake</h2>
            </div>
            <div className="status-pill">
              <Phone size={15} />
              Live
            </div>
          </header>

          <div className="workflow-actions">
            {workflowActions.map((action) => (
              <button key={action.label} onClick={() => sendMessage(action.prompt)} disabled={isStreaming}>
                {action.label}
              </button>
            ))}
          </div>

          <div className="messages">
            {messages.map((message) => (
              <div className={`message-row ${message.role}`} key={message.id}>
                <div className="avatar">{message.role === "assistant" ? <Stethoscope size={16} /> : <UserRound size={16} />}</div>
                <div className="bubble">{message.text || <span className="typing">Receiving...</span>}</div>
              </div>
            ))}
            <div ref={scrollRef} />
          </div>

          {error ? <div className="error-line">{error}</div> : null}

          <div className="composer">
            <button className={`icon-button ${listening ? "active" : ""}`} onClick={simulateVoice} title="Simulate voice input">
              {listening ? <Loader2 size={18} className="spin" /> : <Mic size={18} />}
            </button>
            <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={2} />
            <button className="send-button" onClick={() => sendMessage()} disabled={isStreaming} title="Send message">
              {isStreaming ? <Loader2 size={19} className="spin" /> : <Send size={19} />}
            </button>
          </div>
        </section>

        <aside className="right-rail">
          <section className="confirmation-panel">
            <div className="panel-title">
              <UserRound size={16} />
              Patient memory
            </div>
            {patientMemory?.patient ? (
              <div className="memory-card">
                <strong>{patientMemory.patient.name}</strong>
                <span>{patientMemory.patient.contactPhone ?? "No phone on file"}</span>
                <small>
                  Last symptom: {patientMemory.patient.symptomsHistory?.at(-1)?.symptom ?? "None recorded"}
                </small>
              </div>
            ) : (
              <div className="empty-state">
                <UserRound size={22} />
                <span>No patient selected</span>
              </div>
            )}
          </section>

          <section className="confirmation-panel">
            <div className="panel-title">
              <CalendarCheck size={16} />
              Confirmation
            </div>
            {latestBooking ? (
              <div className="confirmation-card">
                <CheckCircle2 size={22} />
                <strong>{latestBooking.doctorName}</strong>
                <span>{new Date(latestBooking.startTime).toLocaleString()}</span>
                <small>{latestBooking.id}</small>
              </div>
            ) : (
              <div className="empty-state">
                <Clock size={22} />
                <span>Waiting for a booking</span>
              </div>
            )}
          </section>

          <section className="ops-panel">
            <div className="panel-title">
              <Phone size={16} />
              Notifications
            </div>
            <div className="appointment-list">
              {(dashboard?.confirmations ?? []).length === 0 ? <span className="muted">No confirmations sent</span> : null}
              {(dashboard?.confirmations ?? []).slice(-4).map((confirmation) => (
                <div className="appointment-item" key={confirmation.id}>
                  <strong>{confirmation.channel.toUpperCase()} sent</strong>
                  <span>{confirmation.destination}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="ops-panel">
            <div className="panel-title">
              <ShieldAlert size={16} />
              Triage
            </div>
            <div className="appointment-list">
              {(dashboard?.emergencies ?? []).length === 0 ? <span className="muted">No urgent cases</span> : null}
              {(dashboard?.emergencies ?? []).slice(-4).map((item) => (
                <div className="appointment-item emergency" key={item.id}>
                  <strong>{item.severity}</strong>
                  <span>{item.symptoms}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="ops-panel">
            <div className="panel-title">
              <CalendarCheck size={16} />
              Schedule
            </div>
            <div className="appointment-list">
              {(dashboard?.appointments ?? []).slice(-5).map((appointment) => (
                <div className="appointment-item" key={appointment.id}>
                  <strong>{appointment.doctorName}</strong>
                  <span>{new Date(appointment.startTime).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

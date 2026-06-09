# ClinicFlow AI - skills.md

## Overview
This file defines all operational capabilities (skills) available to the ClinicFlow AI agent via tools and workflows.

---

## SKILL 1: Appointment Booking

### Description
Books a patient appointment after verifying doctor availability.

### Tools Used
- check_doctor_availability()
- check_active_bookings()
- book_appointment()
- send_whatsapp_confirmation()

### Inputs
- patient_name
- symptoms
- preferred_time
- doctor_id (optional)

### Output
- confirmed appointment slot
- appointment ID
- confirmation ID

### State Flow
`INTAKE` -> `COLLECT_INFO` -> `MEMORY_LOOKUP` -> `CHECK_AVAILABILITY` -> `BOOK_APPOINTMENT` -> `CONFIRMATION`

### Guardrails
- Check active bookings before `book_appointment()`.
- Do not book a second active appointment for the same patient/date.
- Enforce time-of-day windows: morning 8:00-11:59, afternoon 12:00-16:59, evening 17:00-20:00.

---

## SKILL 2: Reschedule Appointment

### Description
Allows patient to change existing appointment time.

### Tools Used
- fetch_patient_history()
- reschedule_appointment()
- check_doctor_availability()
- send_whatsapp_confirmation()

### Required Inputs
- patient_id or patient name + phone
- existing appointment_id or latest appointment from memory
- preferred replacement time

### State Flow
`MEMORY_LOOKUP` -> `CHECK_AVAILABILITY` -> `RESCHEDULE_APPOINTMENT` -> `CONFIRMATION`

---

## SKILL 3: Patient Memory Lookup

### Description
Retrieves past patient history for personalization.

### Tools Used
- fetch_patient_history()

### Output
- past visits
- symptoms history
- previous appointments

### Memory Boundary
- Use only for clinic workflow continuity.
- Do not infer diagnoses from symptom history.

---

## SKILL 4: Patient Record Creation

### Description
Creates or updates patient profile in system memory.

### Tools Used
- create_or_update_patient_record()

### Data Stored
- name
- phone/contact
- symptom history
- appointment history
- operational notes

---

## SKILL 5: Notification System

### Description
Sends confirmation and reminders to patients.

### Tools Used
- send_whatsapp_confirmation()

### Channels
- whatsapp
- sms
- email

### Failure Behavior
- retry once
- if still failed, show booking reference in chat and mark staff follow-up

---

## SKILL 6: Emergency Detection

### Description
Detects critical health conditions and flags urgency.

### Tools Used
- flag_emergency_case()

### Trigger Conditions
- chest pain
- difficulty breathing
- unconsciousness
- severe injury
- stroke symptoms
- severe bleeding
- seizure
- self-harm risk

### Safety Rule
- Do not diagnose.
- Do not recommend treatment.
- Advise emergency services or nearest ER immediately.
- Emergency routing comes before appointment booking.

---

## Tool Contracts

| Skill | Tool | Required Inputs | Output |
| --- | --- | --- | --- |
| Memory Lookup | `fetch_patient_history()` | patient ID, name, or phone | patient record and appointments |
| Patient Record | `create_or_update_patient_record()` | name, optional phone, symptoms, urgency | patient record |
| Duplicate Guard | `check_active_bookings()` | patient ID, name, or phone; optional date | active bookings |
| Availability | `check_doctor_availability()` | preferred date/time, urgency | available slots |
| Booking | `book_appointment()` | patient, symptoms, doctor ID, slot time | appointment and patient |
| Reschedule | `reschedule_appointment()` | patient ID, appointment ID, new time | updated appointment |
| Notification | `send_whatsapp_confirmation()` | patient ID, appointment ID, channel | confirmation message |
| Emergency | `flag_emergency_case()` | symptoms, severity, reason | emergency record |

---

## Data Models

### Patient
- `id`
- `name`
- `phone`
- `history`
- `appointment_ids`

### Appointment
- `id`
- `patient_id`
- `doctor_id`
- `time`
- `status`

### Doctor Schedule
- `doctor_id`
- `doctor_name`
- `specialty`
- `available_slots`

---

## Skill Execution Rule

- Skills are NOT executed directly
- They are triggered ONLY through agent tool calls
- Agent must always validate input before execution

---

## Goal

Transform natural language patient requests into structured, tool-driven clinic workflows.

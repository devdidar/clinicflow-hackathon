---
name: create-plan
description: Use when planning or rewriting ClinicFlow AI features so work maps patient intent to required intake data, exact tool calls, memory updates, UI evidence, and verification checks.
---

# Create Plan

Use this skill before adding or rewriting ClinicFlow AI features.

## Workflow

1. Identify the patient intent: booking, reschedule, availability, patient history, notification, or emergency.
2. List required data before any action:
   - patient name
   - symptoms or visit reason
   - preferred date/time
   - contact method
   - existing appointment ID when rescheduling
3. Map the feature to exact tools from `SKILL.md`.
4. Define the UI evidence the receptionist sees:
   - intake completion
   - tool execution status
   - patient memory
   - confirmation or triage result
5. Define verification:
   - streamed response delta
   - at least one expected tool event
   - persisted memory or appointment state
   - no confirmation unless the tool succeeded

## Feature Bar

Do not ship a generic chat-only feature. Every feature must expose at least one concrete clinic workflow state in the UI or API.

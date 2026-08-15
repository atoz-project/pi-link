# link_send triggerTurn is required (no default)

The old default (`triggerTurn: false`) silently dropped dispatch messages:
steer delivery into an *idle* receiver lands in its session without waking the
LLM — the message rots until something else wakes it. A master could not tell
"dispatched" from "delivered-but-never-processed".

Decision: `triggerTurn` is **required** in the `link_send` tool schema — the
sender must choose per message (LLM callers self-heal: a validation error
makes them retry with the field). Additionally, a successful direct send with
`triggerTurn: false` to a terminal whose last-known status is idle returns a
warning in the tool result (`⚠ "x" is idle — stored, not processed; resend
with triggerTurn:true or use link_prompt`), and the tool description states
both delivery semantics (busy = steered into the live run; idle = stored, not
processed). `/link-broadcast` keeps its human FYI semantics (always passive).

Considered and rejected: `default: true` (broadcast + default = wake-the-fleet
storm — just a differently-aimed blind default); receiver-side auto-upgrade of
false→true (violates sender intent; passive FYI is legitimate traffic).

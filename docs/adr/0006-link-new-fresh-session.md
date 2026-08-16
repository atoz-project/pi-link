# link_new: remote fresh session without process churn

Retiring a bloated terminal today means killing the process and relaunching
(fleet lifecycle); link_compact is the only remote context operation and it
is lossy-but-alive, not fresh. The fleet wants the third lifecycle op over
the link: start a brand-new session in place. Enabling fact:
`ctx.newSession()` exists — but it tears down the extension instance
(session_shutdown → new instance → session_start), which drops the WebSocket
mid-flight. The design below is shaped by that teardown.

Decision:

1. **Independent `link_new` tool** with a `new_request`/`new_response`
   message pair, mirroring link_compact's shape. Busy guard identical:
   mid-turn, pending remote prompt, or compacting → decline; retry when
   idle. Not a mode on link_compact — compacting and replacing a session are
   different lifecycles; one schema would muddy both.
2. **Identity carries automatically.** The target pre-writes its link-name
   and workspace (ADR-0004) custom entries into the new session via
   `newSession({setup})`, so the new instance rejoins as the same name in
   the same workspace. Without this the new instance would fall back to the
   default name and every address to it would break — so this is not
   optional. No rename-at-new: renaming is `/link-name`'s job.
3. **Ack-before-teardown.** The `new_response` is sent *before* calling
   `ctx.newSession()`, because teardown kills the socket and the responder
   ceases to exist. The ack carries `oldSessionId` — resurrection metadata
   the requester records on the work ticket (fleet convention: resurrect
   only from recorded ids; pi never deletes session files, so "new" destroys
   nothing on disk). Completion signal = the requester observes
   terminal_left → terminal_joined for the same name.
4. **No seed prompt parameter.** The master waits for the rejoin and uses
   link_prompt — task-list alignment happens at that barrier anyway. A seed
   prompt would trade one race (send-after-rejoin) for hidden coupling to
   the teardown window.
5. **State re-announces itself.** Budget, model label, and workspace flow
   from the new instance's own `register`/status channel (ADR-0005); the
   requester's peer context cache resets naturally on rejoin.

Considered and rejected: mode parameter on link_compact (see 1); synchronous
completion — respond only after the new session is up (the pending-response
state would have to survive extension teardown; the object that would reply
is gone); seed prompt (see 4); carrying context excerpts into the new
session via `setup` (that is what compaction is for — "new" means fresh, and
history stays resumable on disk).

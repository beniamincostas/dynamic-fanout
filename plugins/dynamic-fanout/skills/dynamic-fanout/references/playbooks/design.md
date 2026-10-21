# Playbook — design (UX and workflow usability)

Load this when the question is how usable a surface is and what to change: a report or workbook, a
dashboard, a web page, a bot's messages. Typical asks: "is it intuitive", "what does a first-time
user see", "how many clicks", "what happens next", "which hand-offs could the bot take over". It
adds a shape to `research.md`; the foreman kind stays `kind: 'research'`.

## Why it is its own playbook

- **The crew cannot see the surface.** Lean workers read through Bash and have no browser, so the
  visual pass is the master's and runs inline: screenshots of the real thing at a realistic viewport,
  the click test, the empty state. Run it before or while the crew runs.
  - A `worker-mcp` unit with browser tools is the exception, and only with a read-only brief: no click
    that changes data (checkboxes, dropdowns, forms, "open the prefilled form").
- **Design facts live in three places, and the inspector treats them differently:**
  - code: `{file, line, quote}`, grounded by the inspector
  - the live surface: screenshots, master only, not inspector-checkable
  - platform docs: URLs, not inspector-checkable; read them inline with a docs tool
  A unit that cites a URL or a screenshot fails the quote check, so keep those out of crew briefs.

## Angles (one unit each; pack the ones that read the same subtree)

| Unit | What it answers | Typical cell → fb | ctx · check |
|---|---|---|---|
| Touchpoints | every action a person takes: how they learn of it (which message, to whom, when), the clicks from that message to done, what the form or sheet still asks | W·medium → W·high | omit · quote |
| Hand-offs | every step transition: its trigger, who acts, the reminder or escalation, how long a case can wait with nobody told, what the bot could carry forward within the rules | W·medium → W·high | omit · quote |
| Coupling inventory | everything that depends on the surface's shape (names, headers, row or column positions, read-backs, tests, docs): what a redesign must change in lockstep | sonnet·medium → sonnet·high | omit · set+quote |
| Platform capabilities | what the platform can do (one-click links, colours, grouping, card buttons, mentions) | inline, docs tools | — |

- The recall rule applies: touchpoints and hand-offs are "what is there" questions, so they route
  as V0 and stay on W.
- The coupling inventory is mechanical: a missed coupling mostly shows as a failing test at build
  time (V1), so sonnet is right.

## Lenses for the master's pass (and for a second look)

- **First-time reader:** open each screen cold. Can someone new say what to do, where, and what happens
  next?
- **Interaction cost:** count the clicks from the notification to done. A hover-then-popup step
  counts. One decision should cost at most one click plus one deliberate confirmation.
- **Continuity:** after each action, does the surface say what comes next and who acts?
- **Hierarchy:** is the one thing to do the most visible thing (size, colour, position), or do
  frozen frames, long notes or internal codes bury it?
- **Empty and failure states:** what do an empty view, a missing link and a refused write look like?

## Evidence and verification

- **Behaviour claims** cite code (`quote`); skeptics check them as usual. Rungs as in `research.md`
  (high V3, medium V2).
- **Visual claims** cite a screenshot the master took (the screen and what it shows). They are not
  foreman claims: keep them in the synthesis, marked *seen live*.
- **Platform claims** cite the doc page and its sentence, marked *docs*. Verify a claim that decides
  the design (e.g. "a link opens in one click") live when you can.

## Synthesis checklist (master)

- Lead with what a person sees and does today (screens, clicks), then the cause in code, then the
  change.
- Keep three kinds of change apart:
  - layout and look: cheap, reversible
  - interaction: links, buttons, prefill
  - automation: the bot carries a hand-off

  For each, name the rules it must keep.
- List every coupling the change must keep (from the inventory), so the build plan carries it.
- Hand the person a visual of the proposal (mockups of the real surface) before building, when the
  session can make one.

## Practicalities

- Code that is not checked out: see SKILL.md §2. Scope a clean worktree of the reviewed ref.
- Plan mode: the crew is read-only, so a design review may run while planning; implementation may
  not.

# Agent Guidelines

## Evidence-First Rule (Mandatory)

- Do not guess behavior.
- Every implementation or debugging conclusion must be backed by factual evidence from one of:
  - Current repository source code/tests/docs
  - Referenced upstream project code/docs
  - Official tool/CLI documentation output (for example `codex --help`, `gh --help`)
- When behavior is derived from an external reference project, cite the exact file path and relevant code section in the work notes or PR description.
- If evidence is missing or contradictory, stop and ask for clarification instead of inferring.

## For Codex + Slack Behavior Alignment

- Codex scheduling behavior should be aligned with verified upstream patterns.
- Slack sending/thread behavior should be aligned with verified upstream patterns.
- Any deviation from these references must be explicitly documented with rationale and evidence.

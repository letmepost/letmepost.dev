<!--
  Thanks for the PR! Three short sections — please fill all of them.
  If this is a tiny fix (typo, one-line patch), feel free to delete
  sections that don't apply.
-->

## Summary

<!--
  One paragraph. What changed, what user-visible behavior does it move,
  what's the motivation? Link the issue this closes — e.g. `Closes #123`.
-->

## Test plan

<!--
  How you verified this. A checklist works well:

  - [ ] `pnpm typecheck` clean
  - [ ] `pnpm lint` clean
  - [ ] `pnpm test` clean (added/updated tests for the change)
  - [ ] Manually verified [describe the UI flow / curl command / sample payload]
  - [ ] Screenshot or video below (for any UI work)
-->

## Checklist

- [ ] Commit subject follows the `scope: short imperative` style from `CONTRIBUTING.md` §8 (no body, no Co-Authored-By).
- [ ] No raw `Error` thrown — all error paths use `LetmepostError` (`CONTRIBUTING.md` §1).
- [ ] Layering rules respected — publishers / clients / repositories / middleware / routes stay in their lanes (`CONTRIBUTING.md` §2).
- [ ] **New platform?** I followed the `provider.ts → publisher.ts → preflight.ts → client.ts` shape from `CONTRIBUTING.md` §3 and updated the dispatch + scopes registry.
- [ ] Tests follow the MSW + transaction-rollback pattern (`CONTRIBUTING.md` §5).
- [ ] Any new env vars are documented in the relevant `.env.example`.

<!--
  CODEOWNERS auto-requests review from @rosekamallove. CI runs typecheck +
  lint + test on this PR — it must be green before merge.
-->

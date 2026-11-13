# Security

## Reporting a vulnerability

Report it privately through GitHub:
[open a security advisory](https://github.com/StartupBros-com/human-replies-only/security/advisories/new).
Please don't open a public issue for a vulnerability.

Include the version (on your browser's extensions page, or `@version` in the
userscript), the browser, and the steps that show the problem.

## Supported versions

Only the latest release gets fixes. The extension and the userscript are
released together, so update both.

## In scope

The code in this repository: the extension, the userscript, and the scripts
that build and package them. For example:

- a page, a list update or another extension getting Human Replies Only to run code,
  read its stored data, or change its settings;
- muting an account the settings did not allow, or muting from an account other
  than the one the popup names after "Muting as";
- your labels or the mute record leaving the browser.

## Out of scope

- Which accounts are on the list. That list is run by clankwall
  ([clankwall.vogel.dev](https://clankwall.vogel.dev)); report a wrong entry
  there.
- What X does to an account that mutes in bulk. The README's
  [Muting](README.md#muting) section describes that risk, and muting is off
  until you turn it on.
- Bugs in X, the browser or the userscript manager.

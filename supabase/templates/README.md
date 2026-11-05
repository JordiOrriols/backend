# Shared account emails

These English templates belong to the shared Supabase project used by every
app (Agents, Ladders, Planner, Pulse and Shiplog). They live here with the
database and Auth configuration, not in each app. All 13 files are standalone
HTML: Supabase does not assemble a shared layout at send time.

The design follows `@jordiorriols/ui`: cool-gray page, white card, neutral text,
dark action button, subtle borders and an indigo brand accent. Open Sans is
used where available, with email-safe fallbacks and no remote fonts or images.
Layout tables and inline styles keep the content readable without app CSS.

## Install in the hosted project

SMTP is configured separately in the Supabase dashboard. Do not store its
credentials in this repository.

1. Open **Authentication > Email Templates** in the shared project's dashboard.
2. For each template below, paste the entire corresponding HTML file into the
   **Source** editor and set the subject to the text below followed by
   ` | JordiOrriols.cat`.
3. Save each template. Enable the security notifications you want sent; all
   seven are enabled in the local configuration.
4. Disable click/link tracking in your SMTP provider for Auth emails. It can
   rewrite or interfere with one-time verification links.
5. Send a real signup confirmation and password-reset email. Follow each link
   from the mailbox and verify the destination app completes the flow.

| Supabase template     | Subject (before the brand suffix)   | HTML                                                       |
| --------------------- | ----------------------------------- | ---------------------------------------------------------- |
| Confirm signup        | Confirm your email address          | [confirmation.html](./confirmation.html)                   |
| Invite user           | You've been invited                 | [invite.html](./invite.html)                               |
| Magic Link            | Your sign-in link                   | [magic_link.html](./magic_link.html)                       |
| Change Email Address  | Confirm your new email address      | [email_change.html](./email_change.html)                   |
| Reset Password        | Reset your password                 | [recovery.html](./recovery.html)                           |
| Reauthentication      | Your verification code              | [reauthentication.html](./reauthentication.html)           |
| Password changed      | Your password was changed           | [password_changed.html](./password_changed.html)           |
| Email address changed | Your email address was changed      | [email_changed.html](./email_changed.html)                 |
| Phone number changed  | Your phone number was changed       | [phone_changed.html](./phone_changed.html)                 |
| Identity linked       | A new sign-in method was linked     | [identity_linked.html](./identity_linked.html)             |
| Identity unlinked     | A sign-in method was removed        | [identity_unlinked.html](./identity_unlinked.html)         |
| MFA method added      | A new verification method was added | [mfa_factor_enrolled.html](./mfa_factor_enrolled.html)     |
| MFA method removed    | A verification method was removed   | [mfa_factor_unenrolled.html](./mfa_factor_unenrolled.html) |

The exact subjects and content paths also live in [config.toml](../config.toml).
These settings are used by the local Supabase stack. Committing them or running
`supabase db push` does **not** update the hosted email templates. Do not push
the entire local Auth configuration to production to install these emails.

## Authentication links and variables

- Keep `{{ .ConfirmationURL }}` exactly as supplied. It contains the verification
  token, action type and redirect destination. Do not replace it with an app
  homepage or a hardcoded reset-password URL.
- The same confirmation URL is used in the button and copyable fallback link.
- `email_change.html` is worded for confirmation from either the old or new
  mailbox when secure email change requires both confirmations.
- Reauthentication displays `{{ .Token }}` as text, preserving leading zeroes.
- Notifications retain the supplied `.OldEmail`, `.Email`, `.OldPhone`, `.Phone`,
  `.Provider` and `.FactorType` variables. They contain no fake verification
  links, account-management routes or invented support email addresses.
- Security notices retain the instruction to contact support. Add your real
  support contact before publishing if you want a direct contact link; no
  unverified mailbox is included.
- No fixed expiry is promised: Supabase's configured expiry remains authoritative.

## Preview and validation

Open any HTML file in a browser to preview the layout (template variables remain
visible until Supabase renders them). Check a narrow/mobile viewport as well.
Browser previews cannot guarantee identical rendering in Outlook or Gmail;
send test emails to the clients you use before enabling them for everyone.

Run `npx vitest run src/data/__tests__/emailTemplates.test.ts` from the repository
root to check coverage of all templates, their configuration and their variables.

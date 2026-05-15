// Resend email. The ONLY outbound delivery channel.
//
// SPEC invariants honored here:
// - Single recipient (`RECIPIENT_EMAIL`). No multi-recipient path, no allowlist.
// - The caller writes the message to D1 BEFORE calling this -- an email that
//   isn't logged didn't happen.
// - On Resend non-2xx: throw. The caller must leave job/message state so the
//   next run retries (don't advance next_run, don't mark watches done).

export interface EmailArgs {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  // Optional HTML body. When set, most clients render it; clients that don't
  // fall back to `text`. See CLAUDE/claude-cron-EMAIL.md for the formatting
  // contract.
  html?: string;
}

export async function sendEmail(args: EmailArgs): Promise<void> {
  const body: Record<string, string> = {
    from: args.from,
    to: args.to,
    subject: args.subject,
    text: args.text,
  };
  if (args.html) body.html = args.html;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`resend ${res.status}: ${errBody.slice(0, 300)}`);
  }
}

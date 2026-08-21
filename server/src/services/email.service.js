// Uses Brevo's HTTP API, not raw SMTP - cloud hosts commonly block outbound
// SMTP ports as an anti-spam measure, which made emails hang indefinitely
// in production even though the same credentials worked fine locally.
//
// Switched here from Resend: Resend's free tier (without a verified custom
// domain, which costs money to buy) will only deliver to the account
// owner's own address, not arbitrary recipients. Brevo's free tier sends to
// any recipient once a single sender *email* is verified (a confirmation
// link click - no domain or DNS work needed).
const sendEmail = async ({ to, subject, text, html }) => {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: "PaperMind", email: process.env.EMAIL_FROM },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Brevo send failed (${res.status})`);
  }
};

export { sendEmail };

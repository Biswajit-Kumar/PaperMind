import { Resend } from "resend";

// Uses Resend's HTTP API rather than raw SMTP. Cloud hosts commonly block
// outbound SMTP ports (25/465/587) as an anti-spam measure, which made
// verification/reset emails hang indefinitely in production even though
// the exact same SMTP credentials worked fine locally. The API travels
// over normal HTTPS, so it isn't subject to that block.
const resend = new Resend(process.env.RESEND_API_KEY);

const sendEmail = async ({ to, subject, text, html }) => {
  const { error } = await resend.emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    html,
  });

  if (error) {
    throw new Error(error.message || "Failed to send email");
  }
};

export { sendEmail };

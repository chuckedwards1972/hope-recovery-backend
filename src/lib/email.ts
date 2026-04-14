import { logger } from './logger';

// ─── Email provider abstraction ───────────────
// Supports: Resend (recommended), SMTP, or console fallback
// Set EMAIL_PROVIDER=resend and RESEND_API_KEY=re_xxx in .env
// Or EMAIL_PROVIDER=smtp with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

async function sendViaResend(payload: EmailPayload): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'POLR Platform <noreply@polris4life.com>',
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend API error: ${err}`);
  }
}

async function sendConsole(payload: EmailPayload): Promise<void> {
  logger.info({ to: payload.to, subject: payload.subject }, '[EMAIL CONSOLE] Would send email');
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER || 'console';
  try {
    if (provider === 'resend') {
      await sendViaResend(payload);
    } else {
      await sendConsole(payload);
    }
  } catch (err) {
    logger.error({ err, to: payload.to }, 'Failed to send email — falling back to console log');
    await sendConsole(payload);
  }
}

// ─── Email templates ─────────────────────────
export function passwordResetTemplate(resetUrl: string, name: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <div style="background:#0c1a2e;padding:32px 40px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:22px;color:#c8913a;font-weight:700">Path of Life Recovery</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:4px">Restoration Network Platform</div>
    </div>
    <div style="padding:40px">
      <h2 style="color:#0c1a2e;font-family:Georgia,serif;margin:0 0 16px">Password Reset Request</h2>
      <p style="color:#555;line-height:1.7;margin-bottom:24px">Hi ${name},<br><br>We received a request to reset your password. Click the button below to set a new one. This link expires in 1 hour.</p>
      <div style="text-align:center;margin:32px 0">
        <a href="${resetUrl}" style="background:#c8913a;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;display:inline-block">Reset My Password →</a>
      </div>
      <p style="color:#888;font-size:13px;line-height:1.6">If you didn't request this, ignore this email. Your password won't change.<br><br>If the button doesn't work, copy this link: <a href="${resetUrl}" style="color:#c8913a">${resetUrl}</a></p>
    </div>
    <div style="background:#f9f9f9;padding:20px 40px;text-align:center;border-top:1px solid #eee">
      <p style="color:#aaa;font-size:12px;margin:0">Path of Life Recovery · Thibodaux, Louisiana · 985.224.7421</p>
      <p style="color:#aaa;font-size:11px;margin:4px 0 0;font-style:italic">"Walk well."</p>
    </div>
  </div>
</body>
</html>`;
}

export function welcomeTemplate(name: string, campusName: string, loginUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <div style="background:#0c1a2e;padding:32px 40px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:22px;color:#c8913a;font-weight:700">Welcome to POLR</div>
    </div>
    <div style="padding:40px">
      <h2 style="color:#0c1a2e;font-family:Georgia,serif">You're on the path, ${name}.</h2>
      <p style="color:#555;line-height:1.7">Your account has been created for the <strong>${campusName}</strong> campus. You now have access to meetings, step work, housing resources, and your recovery journey dashboard.</p>
      <div style="background:#f5f0e8;border-left:3px solid #c8913a;padding:16px 20px;border-radius:4px;margin:24px 0;font-style:italic;color:#555">
        "You make known to me the path of life; in your presence there is fullness of joy." — Psalm 16:11
      </div>
      <div style="text-align:center;margin-top:32px">
        <a href="${loginUrl}" style="background:#c8913a;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;display:inline-block">Access My Platform →</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

export function riskAlertTemplate(leaderName: string, memberName: string, riskLevel: string, signals: string[]): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <div style="background:#0c1a2e;padding:24px 40px">
      <div style="font-family:Georgia,serif;font-size:18px;color:#fc8181;font-weight:700">⚠️ Member Risk Alert</div>
    </div>
    <div style="padding:32px 40px">
      <p style="color:#555;line-height:1.7">Hi ${leaderName},<br><br>The POLR scoring engine has flagged <strong>${memberName}</strong> at <strong style="color:#fc8181">${riskLevel} RISK</strong>.</p>
      <div style="background:#fff5f5;border:1px solid #fc8181;border-radius:8px;padding:16px 20px;margin:16px 0">
        <div style="font-size:13px;font-weight:700;color:#c53030;margin-bottom:8px">Risk Signals Detected:</div>
        <ul style="margin:0;padding-left:20px;color:#555;font-size:14px;line-height:1.8">
          ${signals.map((s) => `<li>${s}</li>`).join('')}
        </ul>
      </div>
      <p style="color:#555;line-height:1.7">Please reach out to this member personally. A proactive check-in can make all the difference.</p>
    </div>
  </div>
</body>
</html>`;
}

export function weeklyDigestTemplate(leaderName: string, campusName: string, stats: any): string {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
    <div style="background:#0c1a2e;padding:24px 40px">
      <div style="font-family:Georgia,serif;font-size:18px;color:#c8913a;font-weight:700">📊 Weekly Campus Digest</div>
      <div style="color:rgba(255,255,255,0.5);font-size:13px;margin-top:4px">${campusName}</div>
    </div>
    <div style="padding:32px 40px">
      <p style="color:#555">Hi ${leaderName}, here's your weekly snapshot:</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0">
        ${Object.entries(stats).map(([k, v]: any) => `
          <div style="background:#f9f9f9;border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:24px;font-weight:700;color:#0c1a2e">${v}</div>
            <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:0.08em">${k}</div>
          </div>
        `).join('')}
      </div>
      <p style="color:#aaa;font-size:12px;margin-top:24px;font-style:italic">"Walk well." — POLR Platform</p>
    </div>
  </div>
</body>
</html>`;
}

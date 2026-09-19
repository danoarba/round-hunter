const nodemailer = require('nodemailer');
const dns = require('dns');

// Railway/Node often tries IPv6 first → Brevo SMTP ETIMEDOUT
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (_) {}

function getPublicUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN.replace(/\/$/, '')}`;
  }
  return `http://localhost:${process.env.PORT || 3001}`;
}

function parsePayload(lead) {
  let payload = lead.api_payload || {};
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  return payload && typeof payload === 'object' ? payload : {};
}

function cleanDraft(rawDraft = '') {
  const lines = String(rawDraft).trim().split('\n');
  if (lines[0] && lines[0].trim().toLowerCase().startsWith('subject:')) {
    lines.shift();
  }
  return lines.join('\n').trim();
}

function ensureDemoHowto(emailBody, targetEmail) {
  const howto = [
    'How to try your demo (about 3 minutes):',
    `1. For the live demo, use this email inbox: ${targetEmail}`,
    '2. We already sent your personalized demo access there from Dial AI Agent (look for "Your live demo is ready").',
    '3. If you do not see it in Primary, check Promotions, Updates, or All Mail (and Spam just in case).',
    '4. Open that Dial AI Agent email and tap the live demo button inside — it only takes about 3 minutes.',
  ].join('\n');

  const lower = emailBody.toLowerCase();
  if (lower.includes('for the live demo, use this email inbox') && lower.includes('live demo button')) {
    return emailBody;
  }

  const markers = ['\nDanial\n', '\nBest,\n', '\nThanks,\n'];
  for (const marker of markers) {
    if (emailBody.includes(marker)) {
      return emailBody.replace(
        marker,
        `\n\n${howto}\n\nHappy to answer any questions after you try it.${marker}`
      );
    }
  }
  return `${emailBody}\n\n${howto}\n`;
}

function toHtml(plain, businessName, trackingPixel) {
  const paragraphs = plain
    .split('\n')
    .map((line) => {
      const stripped = line.trim();
      if (stripped) {
        return `<p style="margin:0 0 12px 0;line-height:1.6;">${escapeHtml(stripped)}</p>`;
      }
      return '<br/>';
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fff;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="padding:30px 10px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr><td style="padding:20px;">
          ${paragraphs}
          <br/>
          <p style="font-size:11px;color:#aaa;margin-top:30px;line-height:1.5;">
            You are receiving this because we built a custom AI demo specifically for ${escapeHtml(businessName)}.<br/>
            To stop receiving emails, reply with "unsubscribe".
          </p>
          ${trackingPixel}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeDemoPayload(payload, lead) {
  const next = { ...payload };
  const bad = new Set(['danial', 'owner', 'clinic owner', 'clinic team', '']);
  if (bad.has(String(next.full_name || '').trim().toLowerCase())) {
    next.full_name = (lead.ceo_name || '').trim() || lead.name || 'there';
  }
  if (lead.email) next.email = lead.email;

  const map = {
    dental: 'clinic',
    dermatology: 'clinic',
    medspa: 'clinic',
    chiropractic: 'clinic',
    legal: 'lawfirm',
    real_estate: 'realestate',
    fitness: 'gym',
    cafe: 'restaurant',
  };
  if (map[next.business_type]) next.business_type = map[next.business_type];

  const dyn = next.dynamic_fields || {};
  if (dyn && typeof dyn === 'object' && !dyn.coreInfo) {
    const bits = [];
    for (const k of ['services', 'location', 'clinic_timings', 'doctors', 'agent_system_instructions']) {
      if (dyn[k]) bits.push(String(dyn[k]));
    }
    if (bits.length) {
      next.dynamic_fields = {
        features: dyn.features || ['Walk-in Appointments', 'New Patient Registration'],
        coreInfo: bits.join(' '),
      };
    }
  }
  return next;
}

async function triggerDemoToken(lead, log) {
  const payload = normalizeDemoPayload(parsePayload(lead), lead);
  if (!payload || !Object.keys(payload).length) {
    log('sys', 'No demo api_payload — skipping token trigger');
    return false;
  }

  log('sys', `Token trigger (max 25s)...`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const resp = await fetch('https://dialaiagent.com/demo-requests/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        full_name: payload.full_name,
        business_name: payload.business_name,
        email: payload.email,
        phone: payload.phone || '',
        website_url: payload.website_url || '',
        business_type: payload.business_type,
        dynamic_fields: {
          features: (payload.dynamic_fields && payload.dynamic_fields.features) || [],
          coreInfo: (payload.dynamic_fields && payload.dynamic_fields.coreInfo) || '',
          ...(payload.dynamic_fields && payload.dynamic_fields.website_url
            ? { website_url: payload.dynamic_fields.website_url }
            : {}),
        },
      }),
      signal: controller.signal,
    });
    const text = await resp.text();
    log('sys', `Token trigger response: ${resp.status}`);
    if (text) log('sys', `Token trigger body: ${text.slice(0, 280)}`);
    return resp.ok;
  } catch (err) {
    log('alert', `Token trigger skipped: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function createTransporter(port) {
  const user = process.env.BREVO_SMTP_USER || '';
  const pass = process.env.BREVO_SMTP_PASS || '';
  if (!user || !pass) {
    throw new Error('BREVO_SMTP_USER / BREVO_SMTP_PASS missing');
  }
  const secure = port === 465;
  return nodemailer.createTransport({
    host: process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com',
    port,
    secure,
    requireTLS: !secure,
    auth: { user, pass },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 20000,
    tls: { minVersion: 'TLSv1.2', servername: 'smtp-relay.brevo.com' },
    // Force IPv4 — fixes ETIMEDOUT on many Railway containers
    family: 4,
  });
}

async function sendViaBrevoApi(mailOptions, log) {
  const apiKey = process.env.BREVO_API_KEY || process.env.SENDINBLUE_API_KEY || '';
  if (!apiKey) return null;

  log('sys', 'Sending via Brevo HTTPS API...');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { name: 'Danial', email: 'danial@dialaiagent.info' },
        to: [{ email: mailOptions.to }],
        replyTo: { email: 'danial@dialaiagent.info', name: 'Danial' },
        subject: mailOptions.subject,
        htmlContent: mailOptions.html,
        textContent: mailOptions.text,
        headers: {
          'List-Unsubscribe': '<mailto:danial@dialaiagent.info?subject=unsubscribe>',
          Precedence: 'personal',
          'X-Mailer': 'Dial AI Agent Outreach v2',
        },
        tags: ['round-hunter', 'cold-outreach'],
      }),
      signal: controller.signal,
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(body.message || body.error || `Brevo API HTTP ${resp.status}`);
    }
    return { messageId: body.messageId || body.messageIds?.[0] || 'brevo-api' };
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaBrevoSmtp(mailOptions, log) {
  const attempts = [
    { port: 465, label: 'SMTPS:465/IPv4' },
    { port: 2525, label: 'STARTTLS:2525/IPv4' },
    { port: 587, label: 'STARTTLS:587/IPv4' },
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      log('sys', `Connecting to Brevo (${attempt.label})...`);
      const transporter = createTransporter(attempt.port);
      const info = await transporter.sendMail(mailOptions);
      try { transporter.close(); } catch (_) {}
      return info;
    } catch (err) {
      lastErr = err;
      log('alert', `SMTP ${attempt.label} failed: ${err.code || ''} ${err.message}`);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr || new Error('SMTP send failed');
}

async function deliverColdEmail(mailOptions, log) {
  // Prefer HTTPS API (works when Railway blocks outbound SMTP)
  try {
    const viaApi = await sendViaBrevoApi(mailOptions, log);
    if (viaApi) return viaApi;
  } catch (err) {
    log('alert', `Brevo API failed: ${err.message} — falling back to SMTP`);
  }
  return sendViaBrevoSmtp(mailOptions, log);
}

/**
 * Best-effort demo token + required cold email via Brevo (Node).
 * Done/Failed is based on cold email only.
 */
async function sendCampaign(lead, emitLog) {
  const log = (type, text) => {
    if (emitLog) {
      emitLog({
        type,
        id: 'Execution-Bot',
        text,
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      });
    } else {
      console.log(`[${type}] ${text}`);
    }
  };

  const targetEmail = String(lead.email || '').trim();
  const businessName = lead.name || 'Unknown Business';
  if (!targetEmail || !targetEmail.includes('@') || /not_found|no email/i.test(targetEmail)) {
    throw new Error(`invalid target email: ${targetEmail}`);
  }

  log('sys', `Executing campaign for ${businessName} (${targetEmail})...`);

  // Fire demo token in parallel — do not block cold email on SSE hang
  const demoPromise = triggerDemoToken(lead, log).catch(() => false);

  log('sys', `Sending cold email to ${targetEmail}...`);
  const emailBody = ensureDemoHowto(cleanDraft(lead.draft), targetEmail);
  const subject = lead.subject || `quick question about ${businessName}`;
  const publicBase = getPublicUrl();
  const trackingPixel =
    `<img src="${publicBase}/api/track/open/${lead.id}" width="1" height="1" style="display:none;" alt="" />`;
  const html = toHtml(emailBody, businessName, trackingPixel);

  const mailOptions = {
    from: '"Danial" <danial@dialaiagent.info>',
    to: targetEmail,
    replyTo: 'danial@dialaiagent.info',
    subject,
    text: emailBody,
    html,
    headers: {
      'List-Unsubscribe': '<mailto:danial@dialaiagent.info?subject=unsubscribe>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      Precedence: 'personal',
      'X-Mailer': 'Dial AI Agent Outreach v2',
    },
  };

  const info = await deliverColdEmail(mailOptions, log);

  await Promise.race([
    demoPromise,
    new Promise((r) => setTimeout(r, 5000)),
  ]);

  log('success', `Cold email sent successfully to ${targetEmail}! (${info.messageId || 'ok'})`);
  return { ok: true, messageId: info.messageId };
}

module.exports = { sendCampaign, getPublicUrl };

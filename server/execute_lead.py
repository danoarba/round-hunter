import sys
import json
import requests
import time
import smtplib
import os
import uuid
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formatdate, make_msgid
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

def main():
    if len(sys.argv) < 2:
        print("Usage: python execute_lead.py '<json_data>'")
        sys.exit(1)
        
    try:
        data = json.loads(sys.argv[1])
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        sys.exit(1)
        
    # FIX: api_payload is stored as a JSON string in DB, parse it first
    raw_payload = data.get("api_payload", {})
    if isinstance(raw_payload, str):
        try:
            payload = json.loads(raw_payload)
        except:
            payload = {}
    else:
        payload = raw_payload

    # Clean email body
    raw_draft = data.get("draft", "")
    email_lines = raw_draft.strip().split('\n')
    if email_lines and email_lines[0].strip().lower().startswith("subject:"):
        email_lines = email_lines[1:]
    email_body = '\n'.join(email_lines).strip()

    target_email   = data.get("email", "")
    business_name  = data.get("name", "Unknown Business")
    # Use personalized subject from DB, fallback to generic
    subject        = data.get("subject") or f"quick question about {business_name}"
    
    print(f"Executing campaign for {business_name} ({target_email})...")
    
    # -------------------------------------------------------
    # STEP 1: Trigger custom AI demo token on dialaiagent.com
    # -------------------------------------------------------
    print("Step 1: Triggering custom AI demo token on dialaiagent.com...")
    try:
        resp = requests.post(
            "https://dialaiagent.com/demo-requests/stream",
            json=payload,
            timeout=15
        )
        print(f"Token trigger response: {resp.status_code}")
    except Exception as e:
        print(f"Warning: Token trigger failed: {e}")

    # -------------------------------------------------------
    # STEP 2: Wait 10s for demo to generate
    # -------------------------------------------------------
    print("Step 2: Waiting 10 seconds for demo to generate...")
    time.sleep(10)
    
    # -------------------------------------------------------
    # STEP 3: Send spam-proof cold email via Brevo SMTP
    # -------------------------------------------------------
    print(f"Step 3: Sending cold email to {target_email}...")
    
    SENDER_EMAIL    = "danial@dialaiagent.info"
    SENDER_NAME     = "Danial"
    SENDER_DOMAIN   = "dialaiagent.info"
    BREVO_SMTP_USER = os.getenv("BREVO_SMTP_USER", "b78ab6001@smtp-brevo.com")
    BREVO_SMTP_PASS = os.getenv("BREVO_SMTP_PASS", "")
    
    try:
        prospect_id     = data.get("id", "0")
        tracking_pixel  = (
            f'<img src="http://52.77.225.163:3001/api/track/open/{prospect_id}" '
            f'width="1" height="1" style="display:none;" alt="" />'
        )
        
        # ---- Build plain-text version ----
        plain_text = email_body

        # ---- Build clean HTML version ----
        html_paragraphs = ""
        for line in email_body.split('\n'):
            stripped = line.strip()
            if stripped:
                html_paragraphs += f'<p style="margin:0 0 12px 0;line-height:1.6;">{stripped}</p>\n'
            else:
                html_paragraphs += '<br/>\n'

        html_body = f"""\
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#fff;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="padding:30px 10px;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">
        <tr><td style="padding:20px;">
          {html_paragraphs}
          <br/>
          <p style="font-size:11px;color:#aaa;margin-top:30px;line-height:1.5;">
            You are receiving this because we built a custom AI demo specifically for {business_name}.<br/>
            To stop receiving emails, reply with "unsubscribe".
          </p>
          {tracking_pixel}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""

        # ---- Build email with ALL anti-spam headers ----
        msg = MIMEMultipart('alternative')

        # Core headers
        msg['Subject']    = subject
        msg['From']       = f"{SENDER_NAME} <{SENDER_EMAIL}>"
        msg['To']         = target_email
        msg['Reply-To']   = SENDER_EMAIL
        msg['Date']       = formatdate(localtime=True)
        
        # Unique Message-ID per email (critical for deliverability)
        msg['Message-ID'] = make_msgid(domain=SENDER_DOMAIN)

        # RFC 2919 - helps identify the mailing list / sender
        msg['List-Unsubscribe'] = f"<mailto:{SENDER_EMAIL}?subject=unsubscribe>"
        msg['List-Unsubscribe-Post'] = "List-Unsubscribe=One-Click"

        # Precedence: makes Gmail treat it as personal, not bulk
        msg['Precedence'] = "personal"

        # X-Mailer - identify the sender software
        msg['X-Mailer'] = "Dial AI Agent Outreach v2"

        # Attach plain text FIRST (important for spam filters - text:html ratio)
        part1 = MIMEText(plain_text, 'plain', 'utf-8')
        part2 = MIMEText(html_body,  'html',  'utf-8')
        msg.attach(part1)
        msg.attach(part2)
        
        # ---- Send via Brevo SMTP with STARTTLS ----
        server = smtplib.SMTP('smtp-relay.brevo.com', 587)
        server.ehlo()
        server.starttls()
        server.ehlo()
        server.login(BREVO_SMTP_USER, BREVO_SMTP_PASS)
        server.send_message(msg)
        server.quit()
        print(f"Cold email sent successfully to {target_email}!")

    except Exception as e:
        print(f"Error sending email: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

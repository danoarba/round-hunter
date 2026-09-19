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
load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
load_dotenv()  # also allow process env / Railway injected vars

def main():
    if len(sys.argv) < 2:
        print("Usage: python execute_lead.py '<json_data|path.json>'")
        sys.exit(1)

    arg = sys.argv[1]
    try:
        # Prefer temp file path (avoids argv size / quoting hangs on Railway)
        if os.path.isfile(arg):
            with open(arg, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = json.loads(arg)
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

    # Ensure demo-token access instructions are always in the cold email (no website URL — token mail has the live demo button)
    demo_howto = (
        "How to try your demo (about 3 minutes):\n"
        f"1. For the live demo, use this email inbox: {target_email}\n"
        "2. We already sent your personalized demo access there from Dial AI Agent (look for \"Your live demo is ready\").\n"
        "3. If you do not see it in Primary, check Promotions, Updates, or All Mail (and Spam just in case).\n"
        "4. Open that Dial AI Agent email and tap the live demo button inside — it only takes about 3 minutes."
    )
    # Refresh howto if an older draft exists without the inbox line
    if "for the live demo, use this email inbox" not in email_body.lower():
        # Remove older howto block if present, then insert fresh one
        if "how to try your demo" in email_body.lower():
            # Keep body above howto; simplest: append if missing key line
            pass
        sig_markers = ["\nDanial\n", "\nBest,\n", "\nThanks,\n"]
        if "live demo button" not in email_body.lower() or "use this email inbox" not in email_body.lower():
            # If old howto without inbox email, replace a known old block
            old_start = email_body.lower().find("how to try your demo")
            if old_start != -1:
                # cut from howto through line before signature
                before = email_body[:old_start].rstrip()
                after = email_body[old_start:]
                sig_idx = -1
                for marker in ["\nDanial\n", "\nBest,\n", "\nThanks,\n"]:
                    i = after.find(marker)
                    if i != -1:
                        sig_idx = i
                        break
                if sig_idx != -1:
                    email_body = f"{before}\n\n{demo_howto}\n\nHappy to answer any questions after you try it.{after[sig_idx:]}"
                else:
                    email_body = f"{before}\n\n{demo_howto}\n"
            else:
                inserted = False
                for marker in sig_markers:
                    if marker in email_body:
                        email_body = email_body.replace(
                            marker,
                            f"\n\n{demo_howto}\n\nHappy to answer any questions after you try it.{marker}",
                            1
                        )
                        inserted = True
                        break
                if not inserted:
                    email_body = f"{email_body}\n\n{demo_howto}\n"

    print(f"Executing campaign for {business_name} ({target_email})...")

    # Keep demo greeting on the client (never our sender name)
    if isinstance(payload, dict):
        bad_names = {"danial", "owner", "clinic owner", "clinic team", ""}
        if str(payload.get("full_name") or "").strip().lower() in bad_names:
            payload["full_name"] = (
                (data.get("ceo_name") or "").strip()
                or business_name
                or "there"
            )
        if target_email:
            payload["email"] = target_email
    
    # -------------------------------------------------------
    # STEP 1: Trigger custom AI demo token on dialaiagent.com
    # -------------------------------------------------------
    print("Step 1: Triggering custom AI demo token on dialaiagent.com...")
    try:
        # Normalize business_type to official enum if an old payload slips through
        if payload.get("business_type") in ("dental", "dermatology", "medspa", "chiropractic"):
            payload["business_type"] = "clinic"
        if payload.get("business_type") in ("legal",):
            payload["business_type"] = "lawfirm"
        if payload.get("business_type") in ("real_estate",):
            payload["business_type"] = "realestate"
        if payload.get("business_type") in ("fitness",):
            payload["business_type"] = "gym"
        if payload.get("business_type") in ("cafe",):
            payload["business_type"] = "restaurant"

        # Prefer official shallow dynamic_fields shape
        dyn = payload.get("dynamic_fields") or {}
        if "coreInfo" not in dyn and isinstance(dyn, dict):
            # Legacy nested payloads — flatten what we can
            bits = []
            for k in ("services", "location", "clinic_timings", "doctors", "agent_system_instructions"):
                if dyn.get(k):
                    bits.append(str(dyn[k]))
            if bits:
                dyn = {
                    "features": dyn.get("features") or ["Walk-in Appointments", "New Patient Registration"],
                    "coreInfo": " ".join(bits),
                }
                payload["dynamic_fields"] = dyn

        resp = requests.post(
            "https://dialaiagent.com/demo-requests/stream",
            json=payload,
            headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
            timeout=90
        )
        print(f"Token trigger response: {resp.status_code}")
        if resp.text:
            print(f"Token trigger body: {resp.text[:400]}")
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

    if not target_email or "not_found" in target_email.lower() or "no email" in target_email.lower() or "@" not in target_email:
        print(f"Error: invalid target email: {target_email}")
        sys.exit(1)
    
    SENDER_EMAIL    = "danial@dialaiagent.info"
    SENDER_NAME     = "Danial"
    SENDER_DOMAIN   = "dialaiagent.info"
    BREVO_SMTP_USER = os.getenv("BREVO_SMTP_USER", "")
    BREVO_SMTP_PASS = os.getenv("BREVO_SMTP_PASS", "")

    if not BREVO_SMTP_USER or not BREVO_SMTP_PASS:
        print("Error: BREVO_SMTP_USER / BREVO_SMTP_PASS missing. Set them in Railway Variables.")
        sys.exit(1)

    public_base = (os.getenv("PUBLIC_URL") or "").rstrip("/")
    if not public_base:
        domain = (os.getenv("RAILWAY_PUBLIC_DOMAIN") or "").rstrip("/")
        if domain:
            public_base = f"https://{domain}"
    if not public_base:
        public_base = "http://localhost:3001"
    
    try:
        prospect_id     = data.get("id", "0")
        tracking_pixel  = (
            f'<img src="{public_base}/api/track/open/{prospect_id}" '
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
        print("Connecting to Brevo SMTP...")
        server = smtplib.SMTP('smtp-relay.brevo.com', 587, timeout=30)
        server.ehlo()
        server.starttls()
        server.ehlo()
        print("SMTP login...")
        server.login(BREVO_SMTP_USER, BREVO_SMTP_PASS)
        print(f"SMTP sending to {target_email}...")
        server.send_message(msg)
        server.quit()
        print(f"Cold email sent successfully to {target_email}!")

    except Exception as e:
        print(f"Error sending email: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()

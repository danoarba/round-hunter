import imaplib
import email
from email.header import decode_header
import json
import sqlite3
import os
import time
import re
import sys

# Connect to the SQLite database
db_path = os.path.join(os.path.dirname(__file__), 'clients.db')

def log_to_node(type_, id_, text):
    print(json.dumps({
        "type": type_,
        "id": id_,
        "text": text
    }))
    sys.stdout.flush()

def update_prospect_status(email_addr, status):
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Find prospect by email
        cursor.execute("SELECT id, name FROM clients WHERE email = ?", (email_addr,))
        row = cursor.fetchone()
        
        if row:
            prospect_id = row[0]
            name = row[1]
            cursor.execute("UPDATE clients SET status = ? WHERE id = ?", (status, prospect_id))
            conn.commit()
            return prospect_id, name
        return None, None
    except Exception as e:
        log_to_node('alert', 'Inbox-Monitor', f'DB Error: {e}')
        return None, None
    finally:
        if 'conn' in locals():
            conn.close()

def check_inbox():
    # IMAP Configuration
    # Defaults to AWS WorkMail or general IMAP if provided in .env
    IMAP_SERVER = os.environ.get("IMAP_SERVER", "imap.mail.ap-southeast-1.awsapps.com")
    IMAP_USER = os.environ.get("IMAP_USER", "")
    IMAP_PASS = os.environ.get("IMAP_PASS", "")

    if not IMAP_USER or not IMAP_PASS:
        log_to_node('alert', 'Inbox-Monitor', 'IMAP credentials missing. Please set IMAP_USER and IMAP_PASS in .env to enable AI Reply Parser.')
        return

    log_to_node('sys', 'Inbox-Monitor', 'Connecting to IMAP server...')
    
    try:
        mail = imaplib.IMAP4_SSL(IMAP_SERVER)
        mail.login(IMAP_USER, IMAP_PASS)
        mail.select("inbox")

        # Search for unread emails
        status, messages = mail.search(None, "UNSEEN")
        if status != "OK" or not messages[0]:
            log_to_node('sys', 'Inbox-Monitor', 'No new unread emails.')
            return

        for num in messages[0].split():
            status, data = mail.fetch(num, "(RFC822)")
            if status != "OK":
                continue

            for response_part in data:
                if isinstance(response_part, tuple):
                    msg = email.message_from_bytes(response_part[1])
                    
                    # Extract Sender
                    from_header = msg.get("From", "")
                    sender_email = re.search(r'<(.+?)>', from_header)
                    if sender_email:
                        sender_email = sender_email.group(1).strip()
                    else:
                        sender_email = from_header.strip()

                    # Extract Subject
                    subject, encoding = decode_header(msg["Subject"])[0]
                    if isinstance(subject, bytes):
                        try:
                            subject = subject.decode(encoding or "utf-8")
                        except:
                            subject = str(subject)

                    # Extract Body
                    body = ""
                    if msg.is_multipart():
                        for part in msg.walk():
                            if part.get_content_type() == "text/plain":
                                try:
                                    body = part.get_payload(decode=True).decode()
                                except:
                                    pass
                    else:
                        try:
                            body = msg.get_payload(decode=True).decode()
                        except:
                            pass

                    # ---------------------------------------------------------
                    # SIMPLE AI INTENT CLASSIFIER
                    # ---------------------------------------------------------
                    body_lower = body.lower()
                    
                    intent = "Neutral"
                    if any(word in body_lower for word in ["yes", "interested", "demo", "call", "how much", "details", "pricing"]):
                        intent = "Positive"
                    elif any(word in body_lower for word in ["stop", "unsubscribe", "remove", "not interested", "no thanks"]):
                        intent = "Negative"

                    # Update Database Based on Intent
                    if intent == "Positive":
                        prospect_id, name = update_prospect_status(sender_email, 'Hot Lead 🔥')
                        if prospect_id:
                            log_to_node('success', 'Inbox-Monitor', f'Positive reply from {name} ({sender_email})! Marked as Hot Lead 🔥.')
                    elif intent == "Negative":
                        prospect_id, name = update_prospect_status(sender_email, 'Ignored')
                        if prospect_id:
                            log_to_node('alert', 'Inbox-Monitor', f'Negative reply from {name} ({sender_email}). Marked as Ignored.')

        mail.logout()
    except Exception as e:
        log_to_node('alert', 'Inbox-Monitor', f'IMAP Error: {e}')

if __name__ == "__main__":
    check_inbox()

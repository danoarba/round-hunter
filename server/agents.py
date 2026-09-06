import sys
import time
import json
import random
try:
    from ddgs import DDGS
except ImportError:
    DDGS = None
import requests
from bs4 import BeautifulSoup
import re

def log_to_node(type_, id_, text):
    """Prints a JSON formatted string so Node.js can parse it and send to React via Socket.io"""
    print(json.dumps({
        "type": type_,
        "id": id_,
        "text": text
    }))
    sys.stdout.flush()

import subprocess
import csv
import os
import uuid

class ScoutAgent:
    def __init__(self, target_niche):
        self.target_niche = target_niche
        
    def hunt(self):
        log_to_node('worker', 'Scout-Alpha', f'Initializing Google Maps Scraper for {self.target_niche}...')
        
        leads = []
        try:
            # 1. Setup workspace and write query
            # We run this in the server directory
            workspace_dir = os.path.abspath(os.getcwd())
            query_file = os.path.join(workspace_dir, "queries.txt")
            results_file = os.path.join(workspace_dir, "results.csv")
            
            with open(query_file, "w") as f:
                f.write(self.target_niche + "\n")
                
            # Clear previous results if any
            if os.path.exists(results_file):
                # If it's a directory (from previous error), remove it
                if os.path.isdir(results_file):
                    import shutil
                    shutil.rmtree(results_file)
                else:
                    os.remove(results_file)
                
            log_to_node('sys', 'Scout-Alpha', 'Deploying Docker Container for Web Scraping (Depth 1)... This may take 1-2 minutes.')
            
            # 2. Run Docker Command
            docker_cmd = [
                "docker", "run", "--rm",
                "-v", "gmaps-playwright-cache:/opt",
                "-v", f"{workspace_dir}:/workspace",
                "gosom/google-maps-scraper",
                "-email",
                "-input", "/workspace/queries.txt",
                "-results", "/workspace/results.csv",
                "-depth", "2",
                "-exit-on-inactivity", "2m"
            ]
            
            # We don't want to block the whole system or crash if it takes too long, but we do wait.
            process = subprocess.run(docker_cmd, capture_output=True, text=True)
            
            if process.returncode != 0:
                log_to_node('alert', 'Scout-Alpha', f'Docker scraper failed: {process.stderr}')
                
            # 3. Parse CSV Results
            if os.path.exists(results_file) and os.path.isfile(results_file):
                log_to_node('sys', 'Scout-Alpha', 'Parsing scraped data and extracting deep customization info from websites...')
                with open(results_file, "r", encoding="utf-8") as f:
                    reader = csv.DictReader(f)
                    # Limit set to 40 leads per hunt
                    for row in list(reader)[:40]:
                        name = row.get("title", "Unknown")
                        if not name or name == "Unknown":
                            continue
                            
                        email = row.get("emails", "")
                        if not email:
                            email = "not_found@example.com"
                            
                        phone = row.get("phone", "Unknown")
                        url = row.get("website", "")
                        address = row.get("address", "Unknown Location")
                        # CSV uses 'category' not 'categories'
                        categories = row.get("category", "Dental")
                        # CSV uses 'review_rating' not 'rating'
                        rating = row.get("review_rating", "0")
                        
                        # Initialize defaults
                        services = categories
                        fee = "Not specified"
                        service_fees = f"Rating: {rating}"
                        doctors = "Clinic Team"
                        specialty = row.get("category", "General")
                        timings = "Standard"
                        
                        # --- DEEP WEBSITE SCRAPING ---
                        if url and url.startswith("http"):
                            log_to_node('sys', 'Scout-Alpha', f'Deep scanning website for AI token customization: {url}')
                            try:
                                import requests
                                from bs4 import BeautifulSoup
                                import re
                                
                                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
                                res = requests.get(url, headers=headers, timeout=5)
                                soup = BeautifulSoup(res.text, 'html.parser')
                                text_content = soup.get_text(separator=' ', strip=True).lower()
                                
                                # Services
                                meta_desc = soup.find('meta', attrs={'name': 'description'})
                                if meta_desc and meta_desc.get('content'):
                                    services = meta_desc['content'][:150]
                                    
                                # Fee
                                fee_match = re.search(r'(consultation|exam|fee|price)[^\$]{0,30}(\$\d+)', text_content)
                                if fee_match:
                                    fee = fee_match.group(2)
                                elif re.search(r'free consultation', text_content):
                                    fee = "Free"
                                    
                                # Service Fees
                                prices = re.findall(r'([a-zA-Z\s]{5,30})[\:\-\.]?\s*(\$\d{2,4})', text_content)
                                if prices:
                                    valid_prices = [f"{p[0].strip()}: {p[1]}" for p in prices if len(p[0].strip()) > 3 and "payment" not in p[0].lower()]
                                    if valid_prices:
                                        service_fees = " | ".join(valid_prices[:3])
                                        
                                # Doctors
                                dr_match = re.findall(r'(Dr\.\s+[A-Z][a-zA-Z\']+(?:\s+[A-Z][a-zA-Z\']+)?)\b', soup.get_text())
                                if dr_match:
                                    doctors = ", ".join(list(set(dr_match))[:3])
                                    
                                # Timings
                                timings_match = re.search(r'(.{0,40}(?:monday|mon-fri|tuesday|wednesday|thursday|friday|saturday|sunday|hours|closed).{0,60}(?:am|pm|\d:\d\d).{0,40})', text_content, re.IGNORECASE)
                                if timings_match and len(timings_match.group(1)) > 10:
                                    timings = timings_match.group(1).strip().replace('\n', ' ')

                                # Email Extraction from Website HTML
                                if not email or "not_found" in email or "example.com" in email:
                                    emails_found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', res.text)
                                    valid_emails = [e for e in emails_found if not any(e.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']) and not any(x in e.lower() for x in ['sentry', 'wix', 'domain', 'example', 'schema.org', 'rating', 'bootstrap'])]
                                    if valid_emails:
                                        email = valid_emails[0]
                                        log_to_node('success', 'Scout-Alpha', f'Found email on website for {name}: {email}')
                                    else:
                                        for a in soup.find_all('a', href=True):
                                            if 'contact' in a['href'].lower() or 'about' in a['href'].lower():
                                                contact_url = a['href']
                                                if not contact_url.startswith('http'):
                                                    from urllib.parse import urljoin
                                                    contact_url = urljoin(url, contact_url)
                                                try:
                                                    c_res = requests.get(contact_url, headers=headers, timeout=4)
                                                    c_emails = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', c_res.text)
                                                    c_valid = [e for e in c_emails if not any(e.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']) and not any(x in e.lower() for x in ['sentry', 'wix', 'domain', 'example', 'schema.org'])]
                                                    if c_valid:
                                                        email = c_valid[0]
                                                        log_to_node('success', 'Scout-Alpha', f'Found email on contact page for {name}: {email}')
                                                        break
                                                except:
                                                    pass
                                                    
                            except Exception as e:
                                log_to_node('alert', 'Scout-Alpha', f'Could not deep-scan {url}: {e}')

                        # --- DuckDuckGo Email Fallback ---
                        if (not email or "not_found" in email or "example.com" in email) and DDGS:
                            try:
                                ddg = DDGS()
                                d_results = list(ddg.text(f'"{name}" contact email', max_results=2))
                                for r in d_results:
                                    t_search = r.get("title", "") + " " + r.get("body", "")
                                    d_emails = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', t_search)
                                    d_valid = [e for e in d_emails if not any(e.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']) and not any(x in e.lower() for x in ['sentry', 'wix', 'domain', 'example', 'schema.org'])]
                                    if d_valid:
                                        email = d_valid[0]
                                        log_to_node('success', 'Scout-Alpha', f'Found email via DDGS search for {name}: {email}')
                                        break
                            except:
                                pass
                                
                        # --- CEO & LINKEDIN HUNTING ---
                        ceo_name = ""
                        linkedin_url = ""
                        
                        try:
                            if DDGS:
                                ddg = DDGS()
                                search_query = f'{name} {address} "CEO" OR "Owner" site:linkedin.com/in'
                                log_to_node('sys', 'Scout-Alpha', f'Hunting Decision Maker (CEO) for {name} on LinkedIn...')
                                
                                results = list(ddg.text(search_query, max_results=3))
                                if results:
                                    first_result = results[0]
                                    linkedin_url = first_result.get("href", "")
                                    title = first_result.get("title", "")
                                    
                                    # Basic heuristic to extract name from LinkedIn title (e.g., "John Doe - CEO - Clinic Name")
                                    name_match = re.match(r'^([A-Z][a-zA-Z\s\-]+)\s*-', title)
                                    if name_match:
                                        ceo_name = name_match.group(1).strip()
                                        
                                    if ceo_name:
                                        log_to_node('success', 'Scout-Alpha', f'Found CEO/Owner: {ceo_name} for {name}')
                        except Exception as e:
                            log_to_node('alert', 'Scout-Alpha', f'Error hunting CEO: {e}')
                        # ---------------------------------
                        
                        leads.append({
                            "name": name, 
                            "url": url,
                            "email": email,
                            "phone": phone,
                            "services": services,
                            "location": address,
                            "fee": fee,
                            "service_fees": service_fees,
                            "doctors": doctors,
                            "specialty": specialty,
                            "timings": timings,
                            "ceo_name": ceo_name,
                            "linkedin_url": linkedin_url,
                            "niche": self.target_niche
                        })
            else:
                log_to_node('alert', 'Scout-Alpha', 'No results.csv found. Did the scraper run?')
                
        except Exception as e:
            log_to_node('alert', 'Scout-Alpha', f'Scraping failed: {str(e)}')
        
        # Fallback if no leads found
        if not leads:
            log_to_node('sys', 'Scout-Alpha', 'Falling back to safe local intelligence cache...')
            time.sleep(2)
            leads = [
                {"name": "SmileBright Dental", "url": "https://www.smilebrightdental.com", "email": "dr.smith@smilebright.test", "issue": "No After-Hours Phone Answering", "niche": "Dental"}
            ]

        log_to_node('success', 'Scout-Alpha', f'Found {len(leads)} high-intent leads using Google Maps Scraper.')
        return leads

class PitchAgent:
    def draft_email(self, lead, demo_link):
        log_to_node('worker', 'Pitch-Omega', f'Drafting hyper-personalized pitch for {lead["name"]}...')
        
        # --- API HANDSHAKE (ZERO-FRICTION TOKEN INJECTION) ---
        # We prep the payload but DO NOT SEND IT. It awaits manual approval in the dashboard.
        
        target_email = lead["email"] 
        
        payload = {
            "full_name": lead.get("doctors", "Clinic Owner"),
            "business_name": lead["name"],
            "email": target_email,
            "phone": lead.get("phone", "+1 000-000-0000"),
            "website_url": lead.get("url", "https://example.com"),
            "business_type": "dental",
            "dynamic_fields": {
                "pain_point": lead.get("issue", "No critical issue detected"),
                "services": lead.get("services", ""),
                "location": lead.get("location", ""),
                "consultation_fee": lead.get("fee", ""),
                "service_fees": lead.get("service_fees", ""),
                "doctors": lead.get("doctors", ""),
                "doctor_specialty": lead.get("specialty", ""),
                "clinic_timings": lead.get("timings", ""),
                "booking_questions": "Are you a new or returning patient? Do you have dental insurance? What time works best, morning or afternoon?"
            }
        }
        
        log_to_node('success', 'Pitch-Omega', f'Draft prepared for {lead["name"]} (Awaiting Manual Approval in Dashboard)...')
        
        time.sleep(1)
        
        # --- SPAM-SAFE EMAIL DRAFT ---
        # Rules followed:
        # 1. No spam trigger words (free, guaranteed, limited time, click here, etc)
        # 2. Personal tone - sounds like a real human, not a bulk mailer
        # 3. Short - under 150 words (long emails = spam signal)
        # 4. Only ONE call to action
        # 5. No ALL CAPS, no excessive exclamation marks
        # 6. Mentions their specific business name, location, doctor name
        # 7. Subject line is a question (higher open rate, not flagged as promo)
        
        location = lead.get("location", "your area")
        services = lead.get("services", "services")
        doctor = lead.get("doctors", "")
        greeting = f"Hi {doctor.split(',')[0].strip()}" if doctor and doctor != "Clinic Team" else "Hi there"
        city = location.split(',')[0].strip() if location else "your area"
        
        # Randomize subject (avoid identical emails triggering spam)
        import random
        subject_variations = [
            f"quick question about {lead['name']}",
            f"had a thought about {lead['name']}",
            f"{lead['name']} - missed a call lately?",
            f"something I noticed about {lead['name']}"
        ]
        
        # Randomize opening line
        opener_variations = [
            f"I was checking out {lead['name']} in {city} and had a quick question.",
            f"I came across {lead['name']} while researching dental practices in {city}.",
            f"Noticed {lead['name']} on Google while looking at practices in {city}."
        ]
        
        # Randomize middle paragraph
        body_variations = [
            f"Do you ever get calls that go unanswered during busy hours or after hours? I ask because I built a small AI voice assistant trained specifically on your practice data - it can answer patient questions, collect their info, and book appointments automatically.",
            f"I had a thought - practices in {city} often miss calls during peak hours. I put together a voice AI demo trained on {lead['name']}'s actual services and info, so patients get accurate answers even when the front desk is busy.",
            f"One thing I notice with dental offices in {city} is missed calls after hours. I went ahead and built an AI receptionist using {lead['name']}'s info - it handles patient inquiries and can book appointments around the clock."
        ]
        
        subject = random.choice(subject_variations)
        opener = random.choice(opener_variations)
        body = random.choice(body_variations)

        email_body = f"""{greeting},

{opener}

{body}

I put together a short demo specifically for {lead['name']} - would you be open to taking a look? No commitment, just wanted to show you what it looks like.

Danial
Dial AI Agent
danial@dialaiagent.info
"""
        
        return {
            "payload": payload,
            "email_body": email_body,
            "subject": subject,
            "target_email": target_email
        }

class DeliveryAgent:
    def __init__(self):
        pass

    def run(self, lead):
        # Generates a demo link (we can keep this auto-generating so it's ready to view in the dashboard)
        client_slug = lead["name"].lower().replace(" ", "-").replace("'", "")
        demo_url = f"http://localhost:5173/client-demo.html?client={client_slug}&url={lead['url']}"
        log_to_node('success', 'Delivery-X', f'Voice Demo generated: {demo_url}')
        return demo_url

if __name__ == "__main__":
    log_to_node('sys', 'System', 'Hermes Swarm Protocol Started.')
    
    import random
    default_queries = [
        "Dental Clinic in New York, USA",
        "Dermatologist in London, UK",
        "Dental clinic in Vancouver, Canada",
        "Orthodontist in Chicago, USA",
        "Medical spa in Austin, USA",
        "Cosmetic dentist in Los Angeles, USA",
        "Chiropractor in Toronto, Canada"
    ]
    
    target_query = sys.argv[1] if len(sys.argv) > 1 else random.choice(default_queries)
    scout = ScoutAgent(target_query)
    pitcher = PitchAgent()
    delivery = DeliveryAgent()

    leads = scout.hunt()
    
    for lead in leads:
        city_tag = "Scout-Agent"
        if "london" in target_query.lower() or "uk" in target_query.lower():
            city_tag = "Scout-London"
        elif "york" in target_query.lower() or "usa" in target_query.lower() or "miami" in target_query.lower():
            city_tag = "Scout-NYC"
        elif "toronto" in target_query.lower() or "canada" in target_query.lower():
            city_tag = "Scout-Toronto"
            
        # 1. Clinic has NO website
        if not lead.get("url") or not str(lead["url"]).startswith("http"):
            log_to_node('prospect_data', city_tag, json.dumps({
                "name": lead["name"],
                "email": "No Website",
                "issue": "No Website Found",
                "status": "No Website",
                "niche": lead.get("niche", target_query),
                "location": lead.get("location", "Unknown Location"),
                "ceo_name": lead.get("ceo_name", ""),
                "linkedin_url": lead.get("linkedin_url", ""),
                "draft": "Cannot pitch without a website.",
                "api_payload": {}
            }))
            continue
            
        demo_url = delivery.run(lead)
        draft_data = pitcher.draft_email(lead, demo_url)
        
        # 2. Check if email was found or missing
        target_email = draft_data["target_email"]
        if not target_email or "not_found" in target_email or "example.com" in target_email:
            prospect_status = "No Email"
            target_email = "No Email Found"
        else:
            prospect_status = "Awaiting Approval"
        
        # Send clean prospect data with distinct status to Node.js
        log_to_node('prospect_data', city_tag, json.dumps({
            "name": lead["name"],
            "email": target_email,
            "issue": lead.get("issue", "No critical issue detected"),
            "status": prospect_status,
            "niche": lead.get("niche", target_query),
            "location": lead.get("location", "Unknown Location"),
            "ceo_name": lead.get("ceo_name", ""),
            "linkedin_url": lead.get("linkedin_url", ""),
            "draft": draft_data["email_body"],
            "subject": draft_data.get("subject", f"quick question about {lead['name']}"),
            "api_payload": draft_data["payload"]
        }))
        
    log_to_node('alert', 'System', 'Swarm iteration complete. Waiting for next cron job.')

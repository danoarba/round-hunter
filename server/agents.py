import sys
import time
import json
import random
try:
    from ddgs import DDGS
except ImportError:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        DDGS = None
import requests
from bs4 import BeautifulSoup
import re
from urllib.parse import quote, urljoin
import os

def log_to_node(type_, id_, text):
    """Prints a JSON formatted string so Node.js can parse it and send to React via Socket.io"""
    print(json.dumps({
        "type": type_,
        "id": id_,
        "text": text
    }))
    sys.stdout.flush()


class ScoutAgent:
    def __init__(self, target_niche):
        self.target_niche = target_niche
        
    def hunt(self):
        log_to_node('worker', 'Scout-Alpha', f'Initializing Google Maps Scraper for {self.target_niche}...')
        
        leads = []
        try:
            log_to_node('sys', 'Scout-Alpha', 'Searching via DuckDuckGo Search API (Docker bypass)... This may take a few seconds.')
            
            results = []
            if DDGS:
                try:
                    with DDGS() as ddgs:
                        # Find 20 official websites for the niche
                        results = list(ddgs.text(self.target_niche + " official website", max_results=20))
                except Exception as e:
                    log_to_node('alert', 'Scout-Alpha', f'DuckDuckGo Search failed: {e}')
            
            log_to_node('sys', 'Scout-Alpha', 'Parsing search results and extracting deep customization info from websites...')
            
            for row in results:
                name = row.get("title", "Unknown").split('-')[0].split('|')[0].strip()
                if not name or name == "Unknown" or "yelp" in name.lower() or "zocdoc" in name.lower():
                    continue
                    
                url = row.get("href", "") or row.get("link", "")
                if "yelp.com" in url or "zocdoc.com" in url or "healthgrades.com" in url or "yellowpages.com" in url:
                    continue
                    
                email = "not_found@example.com"
                phone = "Unknown"
                # Prefer niche location; enrich from search snippet when possible
                niche_loc = self.target_niche.split(' in ')[-1].strip() if ' in ' in self.target_niche else "Unknown Location"
                snippet = (row.get("body") or row.get("description") or "")
                address = niche_loc
                phone_match = re.search(r'(\+?\d[\d\-\.\s\(\)]{8,}\d)', snippet)
                if phone_match:
                    phone = phone_match.group(1).strip()
                categories = self.target_niche.split(' in ')[0] if ' in ' in self.target_niche else "Business"
                rating = "4.8"
                
                # Initialize defaults
                services = categories
                fee = "Not specified"
                service_fees = f"Rating: {rating}"
                doctors = "Clinic Team"
                specialty = categories
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
                                            contact_url = urljoin(url, contact_url)
                                        try:
                                            c_res = requests.get(contact_url, headers=headers, timeout=4)
                                            c_emails = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', c_res.text)
                                            c_valid = [e for e in c_emails if not any(e.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']) and not any(x in e.lower() for x in ['sentry', 'wix', 'domain', 'example', 'schema.org'])]
                                            if c_valid:
                                                email = c_valid[0]
                                                log_to_node('success', 'Scout-Alpha', f'Found email on contact page for {name}: {email}')
                                                break
                                        except Exception:
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
                
        except Exception as e:
            log_to_node('alert', 'Scout-Alpha', f'Scraping failed: {str(e)}')
        
        if not leads:
            log_to_node('alert', 'Scout-Alpha', 'No leads found this iteration. Check DDGS availability / query niche.')

        log_to_node('success', 'Scout-Alpha', f'Found {len(leads)} high-intent leads via DuckDuckGo + website scrape.')
        return leads

def infer_business_type(niche_or_query):
    q = (niche_or_query or "").lower()
    mapping = [
        (("dental", "dentist", "orthodont"), "dental"),
        (("dermatolog", "skin clinic"), "dermatology"),
        (("medical spa", "med spa", "medspa"), "medspa"),
        (("chiroprac"), "chiropractic"),
        (("restaurant", "dining"), "restaurant"),
        (("cafe", "coffee"), "cafe"),
        (("salon", "barber"), "salon"),
        (("gym", "fitness"), "fitness"),
        (("hotel", "resort"), "hotel"),
        (("law firm", "attorney", "lawyer"), "legal"),
        (("real estate", "realtor"), "real_estate"),
    ]
    for keys, btype in mapping:
        if any(k in q for k in keys):
            return btype
    return "dental"


def industry_label(btype):
    return {
        "dental": "dental practices",
        "dermatology": "dermatology clinics",
        "medspa": "medical spas",
        "chiropractic": "chiropractic clinics",
        "restaurant": "restaurants",
        "cafe": "cafes",
        "salon": "salons",
        "fitness": "gyms",
        "hotel": "hotels",
        "legal": "law firms",
        "real_estate": "real estate agencies",
    }.get(btype, "businesses")


def booking_questions_for(btype):
    if btype in ("restaurant", "cafe", "hotel"):
        return "How many guests? What date and time works best? Any special requests?"
    if btype in ("salon", "fitness"):
        return "Are you a new or returning client? What service do you need? What time works best?"
    if btype == "legal":
        return "What type of legal matter is this? Have you worked with us before? Preferred callback time?"
    if btype == "real_estate":
        return "Are you buying, selling, or renting? Preferred neighborhood? Best time to talk?"
    return "Are you a new or returning patient? Do you have insurance? What time works best, morning or afternoon?"


class PitchAgent:
    def draft_email(self, lead, demo_link):
        log_to_node('worker', 'Pitch-Omega', f'Drafting hyper-personalized pitch for {lead["name"]}...')
        
        target_email = lead["email"]
        niche = lead.get("niche", "")
        btype = infer_business_type(niche)
        label = industry_label(btype)
        is_health = btype in ("dental", "dermatology", "medspa", "chiropractic")
        
        owner_name = lead.get("ceo_name") or lead.get("doctors") or ("Clinic Owner" if is_health else "Owner")
        if owner_name == "Clinic Team":
            owner_name = "Owner"
        
        payload = {
            "full_name": owner_name,
            "business_name": lead["name"],
            "email": target_email,
            "phone": lead.get("phone", "+1 000-000-0000"),
            "website_url": lead.get("url", "https://example.com"),
            "business_type": btype,
            "dynamic_fields": {
                "pain_point": lead.get("issue", "No critical issue detected"),
                "services": lead.get("services", ""),
                "location": lead.get("location", ""),
                "consultation_fee": lead.get("fee", ""),
                "service_fees": lead.get("service_fees", ""),
                "doctors": lead.get("doctors", ""),
                "doctor_specialty": lead.get("specialty", ""),
                "clinic_timings": lead.get("timings", ""),
                "booking_questions": booking_questions_for(btype)
            }
        }
        
        log_to_node('success', 'Pitch-Omega', f'Draft prepared for {lead["name"]} (Awaiting Manual Approval in Dashboard)...')
        
        time.sleep(1)
        
        location = lead.get("location", "your area")
        doctor = lead.get("doctors", "")
        if lead.get("ceo_name"):
            greeting = f"Hi {lead['ceo_name'].split()[0]}"
        elif doctor and doctor != "Clinic Team":
            greeting = f"Hi {doctor.split(',')[0].strip()}"
        else:
            greeting = "Hi there"
        city = location.split(',')[0].strip() if location else "your area"
        
        import random
        subject_variations = [
            f"quick question about {lead['name']}",
            f"had a thought about {lead['name']}",
            f"{lead['name']} - missed a call lately?",
            f"something I noticed about {lead['name']}"
        ]
        
        opener_variations = [
            f"I was checking out {lead['name']} in {city} and had a quick question.",
            f"I came across {lead['name']} while researching {label} in {city}.",
            f"Noticed {lead['name']} on Google while looking at {label} in {city}."
        ]
        
        customer = "patients" if is_health else "customers"
        desk = "front desk" if is_health else "team"
        body_variations = [
            f"Do you ever get calls that go unanswered during busy hours or after hours? I ask because I built a small AI voice assistant trained specifically on your business data - it can answer {customer} questions, collect their info, and book appointments automatically.",
            f"I had a thought - {label} in {city} often miss calls during peak hours. I put together a voice AI demo trained on {lead['name']}'s actual services and info, so {customer} get accurate answers even when the {desk} is busy.",
            f"One thing I notice with {label} in {city} is missed calls after hours. I went ahead and built an AI receptionist using {lead['name']}'s info - it handles inquiries and can book around the clock."
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

    def _public_base(self):
        base = os.environ.get("PUBLIC_URL") or ""
        if not base:
            domain = os.environ.get("RAILWAY_PUBLIC_DOMAIN") or ""
            if domain:
                base = f"https://{domain}"
        if not base:
            base = "http://localhost:3001"
        return base.rstrip("/")

    def run(self, lead):
        client_slug = re.sub(r'[^a-z0-9\-]+', '-', lead["name"].lower()).strip('-')
        site = quote(lead.get("url") or "", safe="")
        demo_url = f"{self._public_base()}/client-demo.html?client={client_slug}&url={site}"
        log_to_node('success', 'Delivery-X', f'Voice Demo generated: {demo_url}')
        return demo_url

if __name__ == "__main__":
    log_to_node('sys', 'System', 'Hermes Swarm Protocol Started.')
    
    import random
    default_queries = [
        "Dental Clinic in New York, USA",
        "Dental Clinic in Los Angeles, USA",
        "Dental Clinic in Chicago, USA",
        "Dental Clinic in Toronto, Canada",
        "Dental Clinic in London, UK",
    ]
    
    target_query = sys.argv[1] if len(sys.argv) > 1 else default_queries[0]
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

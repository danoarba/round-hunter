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
from urllib.parse import quote, urljoin, urlparse
import os

HUNT_QUERY_TEMPLATES = (
    '{industry} {location} official website -school -university -college -.edu -yelp',
    '{industry} {city} contact email phone -directory -zocdoc',
    '"{industry}" "{city}" book appointment -university -student',
    '{industry} near {city} office hours -edu -campus',
)

# UK cold hunt: Cylex Local Search first (https://www.cylex-uk.co.uk/) via DDG — direct scrape is Cloudflare-blocked on servers.
CYLEX_UK_QUERIES = (
    'site:cylex-uk.co.uk/company {industry} {city}',
    'site:cylex-uk.co.uk {industry} {city}',
    'site:cylex-uk.co.uk/company {industry} {location}',
)

_UK_LOCATION_MARKERS = (
    ' uk', ', uk', 'united kingdom', 'england', 'scotland', 'wales', 'northern ireland',
)
_UK_CITIES = (
    'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'edinburgh', 'liverpool',
    'bristol', 'sheffield', 'newcastle', 'nottingham', 'leicester', 'coventry', 'bradford',
    'cardiff', 'belfast', 'brighton', 'cambridge', 'oxford', 'reading', 'southampton',
    'carshalton', 'surrey', 'manchester', 'leeds',
)


def is_uk_target(location):
    loc = (location or '').lower().strip()
    if any(m in loc for m in _UK_LOCATION_MARKERS):
        return True
    city = loc.split(',')[0].strip()
    return city in _UK_CITIES


def is_cylex_uk_url(url):
    return 'cylex-uk.co.uk' in (url or '').lower()


def cylex_company_dedupe_key(url):
    m = re.search(r'/company/([^/?#]+)', url or '', re.I)
    return m.group(1).lower() if m else None


def parse_cylex_listing_title(title):
    t = (title or '').split('|')[0].strip()
    t = re.sub(r'\s*[-–—]\s*Cylex.*$', '', t, flags=re.I)
    t = re.sub(r'\s*,\s*Cylex.*$', '', t, flags=re.I)
    if t.lower().startswith('dentists & dental clinics'):
        return ''
    if ' in ' in t.lower() and t.lower().startswith('dentists'):
        return ''
    return t.strip()


def cylex_search_keyword(industry):
    low = (industry or '').lower()
    mapping = (
        (('dental', 'dentist'), 'dentist'),
        (('orthodont',), 'orthodontist'),
        (('dermatolog',), 'dermatologist'),
        (('chiroprac',), 'chiropractor'),
        (('restaurant',), 'restaurant'),
        (('cafe', 'coffee'), 'cafe'),
        (('hair salon', 'salon'), 'hair salon'),
        (('gym', 'fitness'), 'gym'),
        (('hotel',), 'hotel'),
        (('law firm', 'law'), 'solicitor'),
        (('real estate',), 'estate agent'),
        (('medical spa', 'med spa'), 'medical spa'),
    )
    for keys, word in mapping:
        if any(k in low for k in keys):
            return word
    return (industry or 'business').split(',')[0].strip()[:48]


def fetch_cylex_apify_items(industry, city):
    """
    Structured Cylex UK data via Apify Actor API (bypasses Cloudflare on cylex-uk.co.uk).
    Requires APIFY_API_TOKEN in env. Paid per Apify pricing (~$3.50 / 1k results).
    Returns None if token missing, else list of business records (may be empty).
    """
    token = os.environ.get('APIFY_API_TOKEN') or os.environ.get('APIFY_TOKEN')
    if not token:
        return None
    keyword = cylex_search_keyword(industry)
    max_results = int(os.environ.get('CYLEX_MAX_RESULTS', '12') or '12')
    max_pages = int(os.environ.get('CYLEX_MAX_PAGES', '2') or '2')
    actor = 'vulnv~cylex-uk-scraper'
    endpoint = f'https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items'
    params = {'token': token, 'timeout': 300}
    payload = {
        'search_keyword': keyword,
        'place': city,
        'get_business_details': True,
        'max_results': max_results,
        'max_pages': max_pages,
    }
    log_to_node(
        'sys', 'Cylex-API',
        f'Apify Cylex run — keyword="{keyword}", place="{city}", max_results={max_results}',
    )
    try:
        resp = requests.post(endpoint, params=params, json=payload, timeout=320)
        if resp.status_code not in (200, 201):
            log_to_node(
                'alert', 'Cylex-API',
                f'Apify HTTP {resp.status_code}: {(resp.text or "")[:240]}',
            )
            return []
        body = resp.json()
        if isinstance(body, list):
            return body
        log_to_node('alert', 'Cylex-API', 'Unexpected Apify response shape (expected JSON array).')
        return []
    except Exception as err:
        log_to_node('alert', 'Cylex-API', f'Apify request failed: {err}')
        return []


def scrape_website_enrichment(name, url):
    """Email, phone, services, timings from clinic site (shared by DDG and Apify paths)."""
    out = {
        'email': 'not_found@example.com',
        'phone': 'Unknown',
        'services': '',
        'timings': 'Standard',
        'doctors': 'Clinic Team',
        'fee': 'Not specified',
        'service_fees': '',
    }
    if not url or not str(url).startswith('http'):
        return out
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        res = requests.get(url, headers=headers, timeout=6)
        soup = BeautifulSoup(res.text, 'html.parser')
        text_content = soup.get_text(separator=' ', strip=True)
        text_lower = text_content.lower()
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        if meta_desc and meta_desc.get('content'):
            out['services'] = meta_desc['content'][:150]
        ph = re.search(r'(\+?\d[\d\-\.\s\(\)]{8,}\d)', text_content)
        if ph:
            out['phone'] = ph.group(1).strip()
        emails_found = re.findall(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', res.text)
        best = pick_best_email(filter_valid_emails(emails_found))
        if best:
            out['email'] = best
        else:
            for a in soup.find_all('a', href=True):
                if 'contact' in a['href'].lower() or 'about' in a['href'].lower():
                    contact_url = a['href']
                    if not contact_url.startswith('http'):
                        contact_url = urljoin(url, contact_url)
                    try:
                        c_res = requests.get(contact_url, headers=headers, timeout=4)
                        c_emails = re.findall(
                            r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', c_res.text,
                        )
                        best_c = pick_best_email(filter_valid_emails(c_emails))
                        if best_c:
                            out['email'] = best_c
                            break
                    except Exception:
                        pass
        dr_match = re.findall(
            r'(Dr\.\s+[A-Z][a-zA-Z\']+(?:\s+[A-Z][a-zA-Z\']+)?)\b', soup.get_text(),
        )
        if dr_match:
            out['doctors'] = ', '.join(list(set(dr_match))[:3])
        timings_match = re.search(
            r'(.{0,40}(?:monday|mon-fri|tuesday|wednesday|thursday|friday|saturday|sunday|hours|closed).{0,60}(?:am|pm|\d:\d\d).{0,40})',
            text_lower, re.IGNORECASE,
        )
        if timings_match and len(timings_match.group(1)) > 10:
            out['timings'] = timings_match.group(1).strip().replace('\n', ' ')
        fee_match = re.search(r'(consultation|exam|fee|price)[^\£\$]{0,30}([\£\$]\d+)', text_lower)
        if fee_match:
            out['fee'] = fee_match.group(2)
        elif re.search(r'free consultation', text_lower):
            out['fee'] = 'Free'
    except Exception as e:
        log_to_node('alert', 'Scout-Alpha', f'Could not deep-scan {url}: {e}')
    return out


def resolve_business_website(ddgs, name, city, industry):
    """Find the clinic's own site from a Cylex listing (Cylex HTML is not scrapable on Railway)."""
    if not ddgs or not name:
        return None
    block = ('cylex-uk.co.uk', 'yelp.com', 'facebook.com', 'instagram.com', 'ibegin.com', 'ukorg.org')
    queries = (
        f'"{name}" {city} official website',
        f'{name} {city} {industry} contact email',
    )
    for q in queries:
        try:
            hits = list(ddgs.text(q, max_results=6))
        except Exception:
            continue
        for hit in hits:
            href = hit.get('href') or hit.get('link') or ''
            if not href.startswith('http'):
                continue
            if any(b in href.lower() for b in block):
                continue
            if is_non_commercial_lead(name=name, url=href, snippet=hit.get('body') or ''):
                continue
            return href
    return None

_BAD_EMAIL_FRAGMENTS = (
    'noreply', 'donotreply', 'no-reply', 'privacy@', 'webmaster@',
    'sentry', 'wix', 'example.com', 'schema.org', 'test@', 'you@email',
    'admissions@', 'registrar@', 'student@', '@pg.com', 'crestoralb',
)


def parse_hunt_target(target_niche):
    if ' in ' in (target_niche or ''):
        industry, location = target_niche.split(' in ', 1)
        industry = industry.strip()
        location = location.strip()
        city = location.split(',')[0].strip()
        return industry, location, city
    return (target_niche or 'Business').strip(), 'Unknown Location', (target_niche or 'Business').strip()


def normalize_site_host(url):
    try:
        host = urlparse(url or '').netloc.lower()
        return host[4:] if host.startswith('www.') else host
    except Exception:
        return ''


def pick_best_email(candidates):
    if not candidates:
        return None
    cleaned = []
    for e in candidates:
        el = e.lower().strip()
        if any(x in el for x in _BAD_EMAIL_FRAGMENTS):
            continue
        if el.endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp')):
            continue
        cleaned.append(e)
    if not cleaned:
        return None
    priority = ('info@', 'contact@', 'hello@', 'office@', 'reception@', 'appointments@', 'admin@')
    for prefix in priority:
        for e in cleaned:
            if e.lower().startswith(prefix):
                return e
    return cleaned[0]


def filter_valid_emails(raw_list):
    out = []
    for e in raw_list or []:
        el = e.lower()
        if any(x in el for x in _BAD_EMAIL_FRAGMENTS):
            continue
        if any(el.endswith(ext) for ext in ('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp')):
            continue
        out.append(e)
    return out

def log_to_node(type_, id_, text):
    """Prints a JSON formatted string so Node.js can parse it and send to React via Socket.io"""
    print(json.dumps({
        "type": type_,
        "id": id_,
        "text": text
    }))
    sys.stdout.flush()


# Cold swarm should pitch private clinics — not schools / universities / directories
_SKIP_NAME_KEYWORDS = (
    "school", "university", "college", "academy", "institute of",
    "high school", "elementary", "kindergarten", "preschool",
    "community college", "polytechnic", "campus",
    "nyu ", "columbia university", "harvard", "stanford",
    "admissions", "student clinic", "teaching clinic",
)
_SKIP_HOST_KEYWORDS = (
    ".edu", "school.", "university.", "college.",
    "yelp.com", "zocdoc.com", "healthgrades.com", "yellowpages.com",
    "facebook.com", "linkedin.com", "indeed.com", "glassdoor.com",
)
_SKIP_EMAIL_DOMAINS = (
    ".edu", "school.", "k12.", "ac.uk",
)


def is_non_commercial_lead(name="", url="", email="", snippet=""):
    blob = f"{name} {url} {email} {snippet}".lower()
    if any(k in blob for k in _SKIP_NAME_KEYWORDS):
        return True
    host = (url or "").lower()
    if any(k in host for k in _SKIP_HOST_KEYWORDS):
        return True
    em = (email or "").lower()
    if any(em.endswith(d) or d in em for d in (".edu", ".ac.uk", ".edu.au")):
        return True
    if any(k in em for k in ("@school", "@university", "@college", "admissions@", "registrar@")):
        return True
    return False


class ScoutAgent:
    def __init__(self, target_niche, hunt_mode='rotating'):
        self.target_niche = target_niche
        self.hunt_mode = (hunt_mode or 'rotating').lower()

    def leads_from_cylex_apify(self, industry, location, city):
        items = fetch_cylex_apify_items(industry, city)
        if items is None:
            return None
        leads = []
        seen_hosts = set()
        for item in items:
            name = (item.get('business_name') or '').strip()
            if not name:
                continue
            website = (item.get('website') or '').strip()
            if website and not website.startswith('http'):
                website = f'https://{website.lstrip("/")}'
            listing_url = (item.get('url') or '').strip()
            phones = item.get('phone_numbers') or []
            phone = phones[0] if phones else 'Unknown'
            address = (item.get('address') or location or '').strip()
            services = (item.get('short_description') or '')[:150]
            categories = item.get('categories') or []
            specialty = categories[0] if categories else industry
            timings = (item.get('opening_hours') or 'Standard').strip()
            if len(timings) > 220:
                timings = timings[:220] + '…'
            contacts = item.get('contact_persons') or []
            ceo_name = ''
            if contacts and isinstance(contacts[0], dict):
                ceo_name = (contacts[0].get('name') or '').strip()

            site_url = website if website and not is_cylex_uk_url(website) else ''
            if not site_url:
                log_to_node('sys', 'Cylex-API', f'No own website for {name} — skipped (demo needs clinic site)')
                continue

            host = normalize_site_host(site_url)
            if host and host in seen_hosts:
                continue
            if host:
                seen_hosts.add(host)

            enrich = scrape_website_enrichment(name, site_url)
            email = enrich['email']
            if enrich['phone'] != 'Unknown':
                phone = enrich['phone']
            if enrich['services']:
                services = enrich['services']
            if enrich['timings'] != 'Standard':
                timings = enrich['timings']

            if is_non_commercial_lead(name=name, url=site_url, email=email):
                continue

            has_real_email = email and '@' in email and 'not_found' not in email and 'example.com' not in email
            if self.hunt_mode == 'quality' and not has_real_email:
                log_to_node('sys', 'Cylex-API', f'Quality skip (no email): {name}')
                continue

            leads.append({
                'name': name,
                'url': site_url,
                'email': email,
                'phone': phone,
                'services': services or specialty,
                'location': address,
                'fee': enrich['fee'],
                'service_fees': enrich.get('service_fees') or '',
                'doctors': enrich['doctors'],
                'specialty': specialty,
                'timings': timings,
                'ceo_name': ceo_name,
                'linkedin_url': '',
                'niche': self.target_niche,
                'cylex_listing_url': listing_url,
                'hunt_source': 'cylex_apify',
            })
        return leads
        
    def hunt(self):
        industry, location, city = parse_hunt_target(self.target_niche)
        mode_label = 'Quality (email required)' if self.hunt_mode == 'quality' else 'Rotating local search'
        log_to_node('worker', 'Scout-Alpha', f'Hunt v2 — {mode_label} for {self.target_niche}...')
        
        leads = []
        seen_hosts = set()
        seen_cylex = set()
        uk_hunt = is_uk_target(location)
        uk_source = (os.environ.get('UK_HUNT_SOURCE') or 'auto').strip().lower()

        if uk_hunt and uk_source not in ('ddg', 'free'):
            apify_leads = self.leads_from_cylex_apify(industry, location, city)
            if apify_leads is None:
                if uk_source in ('cylex_api', 'apify'):
                    log_to_node(
                        'alert', 'Cylex-API',
                        'UK_HUNT_SOURCE=cylex_api but APIFY_API_TOKEN is missing.',
                    )
                    return []
                log_to_node(
                    'sys', 'Scout-Alpha',
                    'No Apify token — UK hunt uses DDG + site:cylex-uk.co.uk (add APIFY_API_TOKEN for accurate API data).',
                )
            elif apify_leads:
                log_to_node(
                    'success', 'Scout-Alpha',
                    f'Found {len(apify_leads)} clinic leads (Cylex API via Apify — structured UK directory).',
                )
                return apify_leads
            elif uk_source in ('cylex_api', 'apify'):
                log_to_node('alert', 'Cylex-API', 'Apify returned 0 leads for this keyword and city.')
                return []
            log_to_node('sys', 'Scout-Alpha', 'Apify returned 0 — falling back to DDG Cylex site search...')

        try:
            results = []
            if DDGS:
                try:
                    with DDGS() as ddgs:
                        queries = []
                        if uk_hunt:
                            log_to_node(
                                'sys', 'Scout-Alpha',
                                'UK target → Cylex Local Search first (cylex-uk.co.uk via site: search)...',
                            )
                            for t in CYLEX_UK_QUERIES:
                                queries.append(t.format(industry=industry, location=location, city=city))
                        queries.extend([
                            t.format(industry=industry, location=location, city=city)
                            for t in HUNT_QUERY_TEMPLATES
                        ])
                        # One extra query rotates wording so we do not hit the same SERP every run
                        queries.append(
                            random.choice([
                                f'{industry} {city} new patients welcome -school -.edu',
                                f'best {industry} {city} website -university -yelp',
                                f'{industry} {location} after hours phone -college',
                            ])
                        )
                        for q in queries:
                            log_to_node('sys', 'Scout-Alpha', f'Search: {q[:120]}')
                            try:
                                batch = list(ddgs.text(q, max_results=12))
                                results.extend(batch)
                            except Exception as qerr:
                                log_to_node('alert', 'Scout-Alpha', f'Query failed: {qerr}')
                except Exception as e:
                    log_to_node('alert', 'Scout-Alpha', f'DuckDuckGo Search failed: {e}')
            else:
                log_to_node('alert', 'Scout-Alpha', 'DDGS unavailable.')
            
            log_to_node('sys', 'Scout-Alpha', f'Parsing {len(results)} raw hits (dedupe by domain)...')
            
            ddgs_ctx = None
            if DDGS:
                try:
                    ddgs_ctx = DDGS()
                except Exception:
                    ddgs_ctx = None

            for row in results:
                raw_title = row.get("title", "Unknown")
                url = row.get("href", "") or row.get("link", "")
                snippet = (row.get("body") or row.get("description") or "")
                if not url.startswith('http'):
                    continue

                from_cylex = is_cylex_uk_url(url)
                if from_cylex:
                    if '/company/' not in url.lower():
                        continue
                    ckey = cylex_company_dedupe_key(url)
                    if ckey and ckey in seen_cylex:
                        continue
                    if ckey:
                        seen_cylex.add(ckey)
                    name = parse_cylex_listing_title(raw_title) or raw_title.split('-')[0].split('|')[0].strip()
                    if not name:
                        continue
                    log_to_node('sys', 'Scout-Alpha', f'Cylex listing → resolve website: {name}')
                    resolved = resolve_business_website(ddgs_ctx, name, city, industry)
                    if not resolved:
                        log_to_node('sys', 'Scout-Alpha', f'No own website found for Cylex lead (skipped): {name}')
                        continue
                    else:
                        url = resolved
                        log_to_node('success', 'Scout-Alpha', f'Cylex → site: {url[:100]}')
                else:
                    name = raw_title.split('-')[0].split('|')[0].strip()

                if not name or name == "Unknown" or "yelp" in name.lower() or "zocdoc" in name.lower():
                    continue

                host = normalize_site_host(url)
                if is_cylex_uk_url(url):
                    continue
                if host and host in seen_hosts:
                    continue
                if is_non_commercial_lead(name=name, url=url, snippet=snippet):
                    log_to_node('sys', 'Scout-Alpha', f'Skipped non-clinic (school/edu/directory): {name}')
                    continue
                if any(b in url for b in (
                    "yelp.com", "zocdoc.com", "healthgrades.com", "yellowpages.com",
                    "facebook.com", "instagram.com", "wikipedia.org", "indeed.com",
                    "cylex-uk.co.uk", "branchlocator.cylex",
                )):
                    continue
                if host:
                    seen_hosts.add(host)
                    
                email = "not_found@example.com"
                phone = "Unknown"
                # Prefer niche location; enrich from search snippet when possible
                niche_loc = self.target_niche.split(' in ')[-1].strip() if ' in ' in self.target_niche else "Unknown Location"
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
                            valid_emails = filter_valid_emails(emails_found)
                            best = pick_best_email(valid_emails)
                            if best:
                                email = best
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
                                            c_valid = filter_valid_emails(c_emails)
                                            best_c = pick_best_email(c_valid)
                                            if best_c:
                                                email = best_c
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
                            d_valid = filter_valid_emails(d_emails)
                            best_d = pick_best_email(d_valid)
                            if best_d:
                                email = best_d
                                log_to_node('success', 'Scout-Alpha', f'Found email via DDGS search for {name}: {email}')
                                break
                    except:
                        pass
                        
                ceo_name = ""
                linkedin_url = ""
                if self.hunt_mode == 'quality' and email and '@' in email and 'not_found' not in email:
                    try:
                        if DDGS:
                            with DDGS() as ddg:
                                search_query = f'{name} {city} owner OR dentist site:linkedin.com/in'
                                li_results = list(ddg.text(search_query, max_results=2))
                                if li_results:
                                    first_result = li_results[0]
                                    linkedin_url = first_result.get("href", "")
                                    title = first_result.get("title", "")
                                    name_match = re.match(r'^([A-Z][a-zA-Z\s\-]+)\s*-', title)
                                    if name_match:
                                        ceo_name = name_match.group(1).strip()
                    except Exception as e:
                        log_to_node('alert', 'Scout-Alpha', f'CEO lookup skipped: {e}')
                
                if is_non_commercial_lead(name=name, url=url, email=email, snippet=snippet):
                    log_to_node('sys', 'Scout-Alpha', f'Skipped after scrape (school/edu): {name} / {email}')
                    continue

                has_real_email = email and '@' in email and 'not_found' not in email and 'example.com' not in email
                if self.hunt_mode == 'quality' and not has_real_email:
                    log_to_node('sys', 'Scout-Alpha', f'Quality mode skip (no email): {name}')
                    continue

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

        log_to_node('success', 'Scout-Alpha', f'Found {len(leads)} clinic leads (hunt v2, mode={self.hunt_mode}).')
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


def to_dialai_business_type(btype):
    """Official dialaiagent.com demo enum values."""
    return {
        "dental": "clinic",
        "dermatology": "clinic",
        "medspa": "clinic",
        "chiropractic": "clinic",
        "restaurant": "restaurant",
        "cafe": "restaurant",
        "salon": "salon",
        "fitness": "gym",
        "hotel": "hotel",
        "legal": "lawfirm",
        "real_estate": "realestate",
    }.get(btype, "clinic")


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


def dialai_features_for(btype):
    dial = to_dialai_business_type(btype)
    if dial == "clinic":
        return ["Walk-in Appointments", "Insurance Accepted", "New Patient Registration"]
    if dial == "restaurant":
        return ["Reservations", "Takeout", "Walk-ins Welcome"]
    if dial == "salon":
        return ["Online Booking", "Walk-ins Welcome", "New Client Specials"]
    if dial == "gym":
        return ["Class Booking", "Membership Inquiries", "Trial Visits"]
    if dial == "hotel":
        return ["Reservations", "Concierge Requests", "Late Check-in"]
    if dial == "lawfirm":
        return ["Consultation Booking", "New Client Intake"]
    if dial == "realestate":
        return ["Showing Requests", "Buyer / Seller Intake"]
    return ["Appointment Booking", "New Customer Intake"]


def build_core_info(lead, btype):
    """Official dynamic_fields.coreInfo — plain text receptionist knowledge + booking script."""
    name = lead.get("name") or "the business"
    loc = lead.get("location") or ""
    services = lead.get("services") or ""
    timings = lead.get("timings") or ""
    doctors = lead.get("doctors") or ""
    fee = lead.get("fee") or ""
    phone = lead.get("phone") or ""
    is_health = to_dialai_business_type(btype) == "clinic"
    caller = "patient" if is_health else "client"
    early = "10–15 minutes" if is_health else "10 minutes"
    concern = (
        "Ask what the concern is (pain, cleaning, emergency, checkup, etc.)."
        if is_health
        else "Ask what they need help with today."
    )

    parts = [
        f"You are the front-desk voice receptionist for {name}.",
        "Greet callers warmly using the business name. Sound human, never robotic.",
        "Answer FAQs and book appointments for THIS business only.",
        "Do NOT ask for an email address to help the caller. Email is not needed on the live demo call.",
        "Do NOT pitch Dial AI Agent or ask them to sign up. Stay in character as the receptionist.",
    ]
    if loc and loc != "Unknown Location":
        parts.append(f"Location: {loc}.")
    if phone and phone not in ("Unknown", "+1 000-000-0000", ""):
        parts.append(f"Phone: {phone}.")
    if timings:
        parts.append(f"Hours: {timings if timings != 'Standard' else 'Standard business hours — confirm with the front desk'}." )
    if services:
        parts.append(f"Services: {services}.")
    if doctors:
        parts.append(f"Team: {doctors}.")
    if fee and fee not in ("Not specified", ""):
        parts.append(f"Fee notes: {fee}. If unsure of exact prices, offer a team callback — never invent fees.")

    parts.append(
        "BOOKING FLOW when they want an appointment: "
        f"1) New or returning {caller}? "
        "2) Full name (first and last). "
        "3) Best mobile number (repeat it back). "
        + ("4) Date of birth. " if is_health else "")
        + f"5) {concern} "
        "6) Emergency or same-day slot? "
        "7) Preferred date and time. "
        '8) Say "Hold on one moment while I check availability," pause briefly, then confirm or offer alternatives. '
        "9) Confirm name, date, and time. "
        f'10) Close with "See you on [day] at [time]. Please arrive about {early} early."'
    )
    return " ".join(parts)


def appointment_booking_protocol(btype, business_name):
    """
    Full advanced booking script injected into personalized demo token.
    Agent must follow this turn-by-turn when the caller wants to book.
    """
    is_health = btype in ("dental", "dermatology", "medspa", "chiropractic")
    caller = "patient" if is_health else "client"
    concern_q = (
        "What seems to be the trouble today — pain, swelling, broken tooth, cleaning, or something else?"
        if btype == "dental"
        else (
            "What brings you in today — what symptoms or concerns should we note?"
            if is_health
            else "What can we help you with today?"
        )
    )
    early_mins = "10–15 minutes" if is_health else "10 minutes"

    steps = [
        {
            "step": 1,
            "goal": "greet_and_intent",
            "say": f"Thank you for calling {business_name}. I can help you book an appointment. Are you a new or returning {caller}?",
        },
        {
            "step": 2,
            "goal": "collect_full_name",
            "say": "May I have your full name, please — first and last?",
            "required_fields": ["full_name"],
            "validate": "Must be at least first and last name. If unclear, politely ask them to spell it.",
        },
        {
            "step": 3,
            "goal": "collect_phone",
            "say": "And the best mobile number to reach you on for confirmation and reminders?",
            "required_fields": ["phone"],
            "validate": "Confirm the number back digit-group by digit-group.",
        },
        {
            "step": 4,
            "goal": "collect_dob",
            "say": "For your file, what is your date of birth?",
            "required_fields": ["date_of_birth"],
            "validate": "Accept spoken formats like March 12 1990; repeat it back once to confirm.",
            "skip_if": [] if is_health else ["optional_for_non_health"],
        },
        {
            "step": 5,
            "goal": "collect_concern",
            "say": concern_q,
            "required_fields": ["chief_complaint"],
        },
        {
            "step": 6,
            "goal": "emergency_triage",
            "say": (
                "Do you need an emergency or same-day slot, or is a regular appointment fine?"
                if is_health
                else "Is this urgent for today, or a regular booking?"
            ),
            "required_fields": ["emergency_slot_needed"],
            "rules": [
                "If emergency=yes: prioritize next available urgent slot and note urgency for the front desk.",
                "If severe medical emergency (chest pain, uncontrolled bleeding, difficulty breathing): advise calling emergency services immediately, then offer clinic urgent guidance.",
            ],
        },
        {
            "step": 7,
            "goal": "preferred_datetime",
            "say": "What date and time would you like? Morning or afternoon — or tell me an exact day and time.",
            "required_fields": ["preferred_date", "preferred_time"],
        },
        {
            "step": 8,
            "goal": "availability_hold",
            "say": "Perfect — hold on one moment while I check availability for that day and time.",
            "behavior": [
                "Pause briefly (1–2 seconds) as if checking the schedule.",
                "If the requested slot is free: proceed to confirm.",
                "If not free: offer the two nearest alternatives and ask which they prefer.",
            ],
        },
        {
            "step": 9,
            "goal": "confirm_appointment",
            "say_template": (
                "You're all set. I've booked {full_name} on {confirmed_date} at {confirmed_time}. "
                "We'll text a reminder to {phone}."
            ),
            "required_fields": ["confirmed_date", "confirmed_time"],
        },
        {
            "step": 10,
            "goal": "closing_see_you",
            "say_template": (
                "We'll see you on {confirmed_day_phrase} at {confirmed_time}. "
                f"Please try to arrive about {early_mins} early so check-in is smooth. "
                "Is there anything else I can help you with today?"
            ),
            "examples": [
                "See you tomorrow at 10:00 AM — please arrive a little early.",
                "See you this Thursday at 2:30 PM — come about 10 to 15 minutes early.",
                "Looking forward to seeing you on Monday morning at 9:00 — arrive a bit early if you can.",
            ],
        },
    ]

    return {
        "enabled": True,
        "style": "warm, professional, human — never robotic, never rush the caller",
        "language": "match the caller's language when possible; default English",
        "must_collect_before_confirm": [
            "full_name",
            "phone",
            "date_of_birth" if is_health else None,
            "chief_complaint",
            "emergency_slot_needed",
            "confirmed_date",
            "confirmed_time",
        ],
        "intake_fields": [
            {"id": "full_name", "label": "Full name", "required": True},
            {"id": "phone", "label": "Mobile phone", "required": True},
            {"id": "date_of_birth", "label": "Date of birth", "required": is_health},
            {"id": "chief_complaint", "label": "Reason for visit / what is wrong", "required": True},
            {"id": "emergency_slot_needed", "label": "Emergency / same-day slot?", "required": True},
            {"id": "preferred_date", "label": "Preferred date", "required": True},
            {"id": "preferred_time", "label": "Preferred time", "required": True},
            {"id": "insurance", "label": "Insurance (if mentioned)", "required": False},
        ],
        "steps": steps,
        "hard_rules": [
            "Never confirm an appointment until availability has been 'checked' (step 8).",
            "Always say hold-on / checking availability before confirming a specific requested slot.",
            "Always end with see-you phrasing for the booked day plus arrive-early reminder.",
            "Repeat back name, date, and time once before final goodbye.",
            "If the caller only wants info (hours, fees, services), answer first — then offer to book.",
        ],
    }


class PitchAgent:
    def draft_email(self, lead, demo_link):
        log_to_node('worker', 'Pitch-Omega', f'Drafting hyper-personalized pitch for {lead["name"]}...')
        
        target_email = lead["email"]
        niche = lead.get("niche", "")
        btype = infer_business_type(niche)
        label = industry_label(btype)
        is_health = btype in ("dental", "dermatology", "medspa", "chiropractic")
        
        # dialaiagent demo email greets with full_name — must be the CLIENT, never our sender
        full_name = (lead.get("ceo_name") or "").strip()
        if not full_name or full_name.lower() in ("clinic team", "owner", "clinic owner", "danial"):
            doctors = (lead.get("doctors") or "").strip()
            if doctors and doctors.lower() not in ("clinic team", "owner", "danial"):
                full_name = doctors.split(",")[0].strip()
        if not full_name:
            full_name = (lead.get("name") or "").strip()
        if not full_name:
            em = (target_email or "").strip()
            if "@" in em:
                local = em.split("@")[0]
                if local.lower() not in ("info", "contact", "admin", "office", "hello", "support", "sales", "reception"):
                    full_name = local.replace(".", " ").replace("_", " ").replace("-", " ").title()
        if not full_name:
            full_name = "there"

        # Official dialaiagent.com demo schema (see /demo form)
        phone = lead.get("phone") or ""
        if phone in ("Unknown", "+1 000-000-0000"):
            phone = ""

        payload = {
            "full_name": full_name,
            "business_name": lead["name"],
            "email": target_email,
            "phone": phone,
            "website_url": lead.get("url") or "",
            "business_type": to_dialai_business_type(btype),
            "dynamic_fields": {
                "features": dialai_features_for(btype),
                "coreInfo": build_core_info(lead, btype),
                # Kept for Hermes Intelligence UI + richer personalization
                "services": (lead.get("services") or "").strip() or "General dentistry & family care",
                "clinic_timings": (lead.get("timings") or "").strip() or "Call clinic for current hours",
                "doctors": (lead.get("doctors") or "").strip() or "Clinic Team",
            },
        }
        if payload["website_url"]:
            payload["dynamic_fields"]["website_url"] = payload["website_url"]
        
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

        # Needed-clients lane: hiring / AI-demand angle
        if (lead.get("lane") or "") == "needed" or lead.get("need_signal"):
            signal = (lead.get("need_signal") or lead.get("issue") or "hiring a virtual / remote receptionist").strip()
            subject = random.choice([
                f"re: {lead['name']} — virtual receptionist",
                f"instead of hiring another receptionist at {lead['name']}",
                f"saw the receptionist need at {lead['name']}",
            ])
            opener = f"I noticed a signal that {lead['name']} may be looking for help with phones / front desk ({signal})."
            body = (
                f"Instead of another remote or virtual receptionist hire, I built a live AI voice receptionist "
                f"trained on {lead['name']}'s own info — it can answer {customer}, take details, and book around the clock."
            )

        email_body = f"""{greeting},

{opener}

{body}

I put together a short personalized demo specifically for {lead['name']} — would you be open to taking a look? No commitment, just wanted to show you what it looks like.

How to try your demo (about 3 minutes):
1. For the live demo, use this email inbox: {target_email}
2. We already sent your personalized demo access there from Dial AI Agent (look for "Your live demo is ready").
3. If you do not see it in Primary, check Promotions, Updates, or All Mail (and Spam just in case).
4. Open that Dial AI Agent email and tap the live demo button inside — it only takes about 3 minutes.

Happy to answer any questions after you try it.

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
    def run(self, lead):
        public_base = (os.getenv("PUBLIC_URL") or "").rstrip("/")
        if not public_base:
            domain = (os.getenv("RAILWAY_PUBLIC_DOMAIN") or "").rstrip("/")
            if domain:
                public_base = f"https://{domain}"
        if not public_base:
            public_base = "http://localhost:3001"
        slug = re.sub(r'[^a-z0-9]+', '-', (lead.get("name") or "client").lower()).strip('-')[:48]
        url = lead.get("url") or ""
        demo = f"{public_base}/client-demo.html?client={quote(slug)}&url={quote(url)}"
        log_to_node('success', 'Delivery-X', f'Voice Demo generated: {demo}')
        return demo


class IntentNeedScout:
    """Hunt businesses that already signal need for virtual/AI receptionist help."""

    INTENT_QUERIES = [
        'hiring "virtual receptionist" dental OR clinic OR salon OR spa',
        '"remote receptionist" (dental OR clinic OR "medical spa") hiring',
        '"looking for" ("AI receptionist" OR "AI phone agent" OR "voice AI") clinic',
        '"answering service" OR "after hours calls" dental hiring receptionist',
        '"virtual receptionist" job dental clinic',
    ]

    def hunt(self):
        log_to_node('worker', 'Need-Scout', 'Hunting Needed Clients (hiring / AI receptionist demand signals)...')
        leads = []
        seen = set()
        if not DDGS:
            log_to_node('alert', 'Need-Scout', 'DDGS unavailable — cannot hunt needed clients this iteration.')
            log_to_node('success', 'Need-Scout', 'Found 0 high-intent leads via DuckDuckGo + website scrape.')
            return leads

        try:
            with DDGS() as ddgs:
                for q in self.INTENT_QUERIES:
                    log_to_node('sys', 'Need-Scout', f'Intent query: {q}')
                    try:
                        rows = list(ddgs.text(q, max_results=8))
                    except Exception as e:
                        log_to_node('alert', 'Need-Scout', f'Query failed: {e}')
                        continue
                    for row in rows:
                        title = (row.get("title") or "Unknown").split('|')[0].split('-')[0].strip()
                        href = row.get("href") or row.get("link") or ""
                        body = row.get("body") or row.get("description") or ""
                        blob = f"{title} {body}".lower()
                        if not any(k in blob for k in (
                            "receptionist", "answering", "hiring", "remote", "virtual",
                            "ai phone", "ai receptionist", "voice ai", "front desk"
                        )):
                            continue
                        # Skip pure job-board noise without a usable company angle
                        if any(x in href for x in ("linkedin.com/jobs", "glassdoor.com", "ziprecruiter.com")):
                            # Still try to pull company-like name from title
                            pass
                        company = title
                        for noise in ("Hiring", "Job", "Jobs", "Indeed", "Remote", "Full Time", "Part Time"):
                            company = company.replace(noise, "").strip(" -|:")
                        if len(company) < 3:
                            continue
                        key = company.lower()
                        if key in seen:
                            continue
                        seen.add(key)

                        # Resolve official website
                        site_url = ""
                        try:
                            site_hits = list(ddgs.text(f'{company} official website', max_results=5))
                            for hit in site_hits:
                                u = hit.get("href") or hit.get("link") or ""
                                if not u.startswith("http"):
                                    continue
                                if any(b in u for b in (
                                    "indeed.com", "linkedin.com", "glassdoor.com", "yelp.com",
                                    "zocdoc.com", "facebook.com", "wikipedia.org"
                                )):
                                    continue
                                site_url = u
                                break
                        except Exception:
                            pass

                        email = "not_found@example.com"
                        phone = "Unknown"
                        services = "Front desk / patient calls"
                        timings = "Standard"
                        doctors = "Clinic Team"
                        if site_url:
                            try:
                                headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
                                res = requests.get(site_url, headers=headers, timeout=5)
                                soup = BeautifulSoup(res.text, 'html.parser')
                                text_content = soup.get_text(separator=' ', strip=True)
                                emails = re.findall(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', text_content)
                                emails = [e for e in emails if not any(x in e.lower() for x in (
                                    "example.com", "sentry", "wixpress", "cloudflare", "schema"
                                ))]
                                if emails:
                                    email = emails[0]
                                ph = re.search(r'(\+?\d[\d\-\.\s\(\)]{8,}\d)', text_content)
                                if ph:
                                    phone = ph.group(1).strip()
                                meta_desc = soup.find('meta', attrs={'name': 'description'})
                                if meta_desc and meta_desc.get('content'):
                                    services = meta_desc['content'][:150]
                            except Exception as e:
                                log_to_node('alert', 'Need-Scout', f'Site scrape failed for {company}: {e}')

                        signal = "Hiring / demand signal for virtual or remote receptionist / AI phone help"
                        if "ai" in blob:
                            signal = "Actively exploring AI receptionist / voice agent"
                        elif "hiring" in blob or "job" in blob:
                            signal = "Hiring virtual / remote receptionist (job demand)"

                        leads.append({
                            "name": company[:120],
                            "url": site_url,
                            "email": email,
                            "phone": phone,
                            "services": services,
                            "location": "Unknown Location",
                            "fee": "Not specified",
                            "service_fees": "",
                            "doctors": doctors,
                            "specialty": "Needed Client — receptionist demand",
                            "timings": timings,
                            "ceo_name": "",
                            "linkedin_url": "",
                            "issue": signal,
                            "need_signal": signal,
                            "lane": "needed",
                            "niche": "Needed Clients — AI / virtual receptionist demand",
                        })
                        if len(leads) >= 12:
                            break
                    if len(leads) >= 12:
                        break
        except Exception as e:
            log_to_node('alert', 'Need-Scout', f'Intent hunt failed: {e}')

        log_to_node('success', 'Need-Scout', f'Found {len(leads)} high-intent leads via DuckDuckGo + website scrape.')
        return leads


def emit_prospect_from_lead(lead, pitcher, delivery, lane="standard"):
    city_tag = "Need-Scout" if lane == "needed" else "Scout-Agent"
    if not lead.get("url") or not str(lead["url"]).startswith("http"):
        log_to_node('prospect_data', city_tag, json.dumps({
            "name": lead["name"],
            "email": "No Website",
            "issue": lead.get("issue") or "No Website Found",
            "status": "No Website",
            "niche": lead.get("niche", ""),
            "location": lead.get("location", "Unknown Location"),
            "ceo_name": lead.get("ceo_name", ""),
            "linkedin_url": lead.get("linkedin_url", ""),
            "draft": "Cannot pitch without a website.",
            "api_payload": {},
            "lane": lane,
            "need_signal": lead.get("need_signal", ""),
        }))
        return

    lead = {**lead, "lane": lane}
    demo_url = delivery.run(lead)
    draft_data = pitcher.draft_email(lead, demo_url)
    target_email = draft_data["target_email"]
    if not target_email or "not_found" in target_email or "example.com" in target_email:
        prospect_status = "No Email"
        target_email = "No Email Found"
    else:
        prospect_status = "Awaiting Approval"

    log_to_node('prospect_data', city_tag, json.dumps({
        "name": lead["name"],
        "email": target_email,
        "issue": lead.get("issue", "No critical issue detected"),
        "status": prospect_status,
        "niche": lead.get("niche", ""),
        "location": lead.get("location", "Unknown Location"),
        "ceo_name": lead.get("ceo_name", ""),
        "linkedin_url": lead.get("linkedin_url", ""),
        "draft": draft_data["email_body"],
        "subject": draft_data.get("subject", f"quick question about {lead['name']}"),
        "api_payload": draft_data["payload"],
        "lane": lane,
        "need_signal": lead.get("need_signal", ""),
    }))


if __name__ == "__main__":
    log_to_node('sys', 'System', 'Hermes Swarm Protocol Started.')

    args = sys.argv[1:]
    lane = "standard"
    if "--lane" in args:
        i = args.index("--lane")
        if i + 1 < len(args):
            lane = args[i + 1].strip().lower()
            del args[i:i + 2]
    if args and args[0] in ("needed", "need", "intent"):
        lane = "needed"
        args = args[1:]

    default_queries = [
        "Dental Clinic in New York, USA",
        "Dental Clinic in Los Angeles, USA",
        "Dental Clinic in Chicago, USA",
        "Dental Clinic in Toronto, Canada",
        "Dental Clinic in London, UK",
    ]

    hunt_mode = os.environ.get('HUNT_MODE', 'rotating').strip().lower()
    if '--hunt-mode' in args:
        i = args.index('--hunt-mode')
        if i + 1 < len(args):
            hunt_mode = args[i + 1].strip().lower()
            del args[i:i + 2]

    target_query = args[0] if args else default_queries[0]
    pitcher = PitchAgent()
    delivery = DeliveryAgent()

    if lane == "needed":
        log_to_node('sys', 'System', 'Lane: Needed Clients (intent / hiring demand).')
        leads = IntentNeedScout().hunt()
        for lead in leads:
            emit_prospect_from_lead(lead, pitcher, delivery, lane="needed")
    else:
        log_to_node('sys', 'Scout-Alpha', f'Cold hunt mode: {hunt_mode}')
        scout = ScoutAgent(target_query, hunt_mode=hunt_mode)
        leads = scout.hunt()
        for lead in leads:
            emit_prospect_from_lead(lead, pitcher, delivery, lane="standard")

    log_to_node('alert', 'System', 'Swarm iteration complete. Waiting for next cron job.')

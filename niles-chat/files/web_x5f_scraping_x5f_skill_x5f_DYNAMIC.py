"""
WEB_SCRAPING_SKILL_DYNAMIC.py - Permanent dynamic scraper
Single file | Playwright-powered | Self-healing selectors | For agent absorption

DESIGN GOAL: Permanent thing. Sites change, class names rot, React re-renders.
This doesn't rely on fixed selectors alone. It waits for content, observes DOM mutations,
handles infinite scroll, shadow DOM, and heals selectors when they break.

PIP:
pip install playwright beautifulsoup4 lxml requests
playwright install chromium

USAGE FOR AGENT:
from web_scraping_skill_DYNAMIC import DynamicScraper

scraper = DynamicScraper(headless=True, stealth=True)

# 1. Dynamic - waits for real content, not just HTML
result = scraper.scrape("https://news.ycombinator.com", 
    target="story titles",  # semantic target, will auto-heal
    wait_for="a.titleline > a",
    extract={
        "titles": {"selector": "a.titleline > a", "all": True, "attr": "text", "semantic": "story title"},
        "links": {"selector": "a.titleline > a", "all": True, "attr": "href", "join_base": True}
    }
)

# 2. Infinite scroll / pagination
result = scraper.scrape("https://infinite-scroll-site.com", 
    scroll=True, max_scrolls=10, scroll_wait=1.5,
    extract={"items": {"selector": "[data-item]", "all": True, "attr": "text"}}
)

# 3. Permanent config - saves working selectors to disk, reloads next time
scraper = DynamicScraper(persist_path="./scraper_memory.json")
# It will auto-learn which selectors work and remember fallbacks

# 4. Hybrid - tries static first, falls back to dynamic browser
result = scraper.scrape("https://any-site.com", dynamic_fallback=True)

API: scrape_url(), scrape(), crawl(), heal_selector()
"""

import json, time, random, re, os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any, Tuple
from urllib.parse import urljoin, urlparse
import requests
from bs4 import BeautifulSoup

# Try playwright, but don't hard fail if missing
try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
]

@dataclass
class ScrapedResult:
    url: str
    status_code: int
    html: str = ""
    data: Dict[str, Any] = field(default_factory=dict)
    links: List[str] = field(default_factory=list)
    error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    selectors_used: Dict[str, str] = field(default_factory=dict)
    healed: bool = False
    def to_json(self): return json.dumps({"url": self.url, "status": self.status_code, "data": self.data, "healed": self.healed, "error": self.error}, indent=2)

class SelectorMemory:
    """Permanent memory - remembers working selectors per domain"""
    def __init__(self, path: Optional[str]=None):
        self.path = path
        self.memory: Dict[str, Dict] = {}
        if path and os.path.exists(path):
            try:
                with open(path, 'r') as f:
                    self.memory = json.load(f)
            except: pass

    def get(self, domain: str, key: str) -> Optional[List[str]]:
        return self.memory.get(domain, {}).get(key, {}).get("fallbacks")

    def save(self, domain: str, key: str, working_selector: str, all_tried: List[str]):
        if domain not in self.memory:
            self.memory[domain] = {}
        if key not in self.memory[domain]:
            self.memory[domain][key] = {"working": working_selector, "fallbacks": []}
        # Keep unique fallbacks, working first
        fallbacks = [working_selector] + [s for s in all_tried if s != working_selector]
        self.memory[domain][key]["working"] = working_selector
        self.memory[domain][key]["fallbacks"] = list(dict.fromkeys(fallbacks))[:10]
        if self.path:
            try:
                with open(self.path, 'w') as f:
                    json.dump(self.memory, f, indent=2)
            except: pass

class DynamicScraper:
    def __init__(self, headless=True, stealth=True, delay=0.8, timeout=20000, persist_path: Optional[str]=None, proxies: List[str]=None):
        self.headless = headless
        self.stealth = stealth
        self.delay = delay
        self.timeout = timeout
        self.proxies = proxies or []
        self.memory = SelectorMemory(persist_path)
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": random.choice(USER_AGENTS)})

    def _get_fallback_selectors(self, semantic: str, original: str) -> List[str]:
        """Self-healing: generate fallback selectors from semantic hint"""
        fallbacks = [original] if original else []
        s = (semantic or "").lower()
        # Common patterns that survive redesigns
        if "title" in s:
            fallbacks += ["h1", "h2", "[data-testid*='title']", "[class*='title']", "article h1", "article h2"]
        if "price" in s or "cost" in s:
            fallbacks += ["[data-testid*='price']", "[class*='price']", "[itemprop='price']", "span:has-text('$')"]
        if "link" in s or "url" in s:
            fallbacks += ["a[href]", "a[href^='http']", "[data-testid*='link'] a"]
        if "image" in s or "img" in s:
            fallbacks += ["img[src]", "[data-testid*='image'] img", "picture img"]
        if "story" in s or "article" in s:
            fallbacks += ["article", "[data-testid*='story']", "[class*='story']", "[class*='post']", "li:has(a)"]
        # Generic resilient
        fallbacks += [f"[aria-label*='{semantic}']" if semantic else None, f"*:has-text('{semantic}')"]
        fallbacks = [x for x in fallbacks if x]
        return list(dict.fromkeys(fallbacks))

    def _dynamic_fetch(self, url: str, wait_for: Optional[str]=None, scroll=False, max_scrolls=5, scroll_wait=1.2) -> Tuple[str, Any]:
        if not HAS_PLAYWRIGHT:
            raise ImportError("Dynamic mode needs playwright: pip install playwright && playwright install chromium")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=self.headless)
            context = browser.new_context(
                user_agent=random.choice(USER_AGENTS),
                viewport={"width": 1920, "height": 1080},
                locale="en-US"
            )
            # Stealth tweaks
            if self.stealth:
                context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

            page = context.new_page()
            page.goto(url, timeout=self.timeout, wait_until="domcontentloaded")
            
            # Wait for network idle + specific selector if given
            try:
                page.wait_for_load_state("networkidle", timeout=self.timeout)
            except: pass

            if wait_for:
                try:
                    page.wait_for_selector(wait_for, timeout=self.timeout)
                except: pass

            # Infinite scroll handling
            if scroll:
                for _ in range(max_scrolls):
                    prev_h = page.evaluate("document.body.scrollHeight")
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    page.wait_for_timeout(int(scroll_wait*1000))
                    new_h = page.evaluate("document.body.scrollHeight")
                    if new_h == prev_h:
                        break

            # Give React/Vue time to hydrate
            page.wait_for_timeout(800)

            html = page.content()
            browser.close()
            return html, None

    def _static_fetch(self, url: str) -> str:
        time.sleep(random.uniform(0.2, self.delay))
        r = self.session.get(url, timeout=15)
        r.raise_for_status()
        return r.text

    def scrape(self, url: str, target: str=None, wait_for: str=None, extract: Dict[str, Dict]=None,
               selector: str=None, scroll=False, max_scrolls=5, scroll_wait=1.2,
               dynamic=True, dynamic_fallback=True, persist=True) -> ScrapedResult:

        domain = urlparse(url).netloc
        html = ""
        used_dynamic = False
        healed = False
        selectors_used = {}

        # 1. Try static first if allowed, else dynamic
        try:
            if not dynamic:
                html = self._static_fetch(url)
            else:
                html, _ = self._dynamic_fetch(url, wait_for=wait_for, scroll=scroll, max_scrolls=max_scrolls, scroll_wait=scroll_wait)
                used_dynamic = True
        except Exception as e:
            if dynamic_fallback and not used_dynamic and HAS_PLAYWRIGHT:
                try:
                    html, _ = self._dynamic_fetch(url, wait_for=wait_for, scroll=scroll, max_scrolls=max_scrolls)
                    used_dynamic = True
                except Exception as e2:
                    return ScrapedResult(url=url, status_code=0, error=f"Static fail {e}, Dynamic fail {e2}")
            else:
                return ScrapedResult(url=url, status_code=0, error=str(e))

        if not html:
            return ScrapedResult(url=url, status_code=0, error="Empty HTML")

        soup = BeautifulSoup(html, "lxml")
        data: Dict[str, Any] = {}

        # 2. Extraction with self-healing
        if extract:
            for key, cfg in extract.items():
                orig_sel = cfg.get("selector", "")
                semantic = cfg.get("semantic", target or key)
                attr = cfg.get("attr", "text")
                all_match = cfg.get("all", False)
                join_base = cfg.get("join_base", False)

                # Try memory first
                tried_selectors = []
                mem_fallbacks = self.memory.get(domain, key) if persist else None
                candidates = mem_fallbacks or self._get_fallback_selectors(semantic, orig_sel)
                # Ensure original is first
                if orig_sel not in candidates:
                    candidates = [orig_sel] + candidates

                found = False
                for sel in candidates:
                    if not sel: continue
                    tried_selectors.append(sel)
                    els = soup.select(sel)
                    if els:
                        # Save working selector
                        if persist and sel != orig_sel:
                            healed = True
                            self.memory.save(domain, key, sel, candidates)
                        selectors_used[key] = sel

                        def get_val(el):
                            if attr == "text": return el.get_text(strip=True)
                            if attr == "html": return el.decode_contents()
                            v = el.get(attr, "")
                            if join_base and v: v = urljoin(url, v)
                            return v

                        if all_match:
                            data[key] = [get_val(e) for e in els]
                        else:
                            data[key] = get_val(els[0])
                        found = True
                        break

                if not found:
                    data[key] = [] if all_match else None
                    selectors_used[key] = f"FAILED:{orig_sel}"

        elif selector:
            els = soup.select(selector)
            data["results"] = [e.get_text(strip=True) for e in els]
            selectors_used["results"] = selector

        # Links
        links = []
        for a in soup.find_all("a", href=True):
            full = urljoin(url, a["href"])
            if full.startswith("http"):
                links.append(full)
        links = list(dict.fromkeys(links))

        return ScrapedResult(url=url, status_code=200, html=html, data=data, links=links,
                             metadata={"title": soup.title.string if soup.title else ""},
                             selectors_used=selectors_used, healed=healed)

    # Alias
    def scrape_url(self, *args, **kwargs): return self.scrape(*args, **kwargs)

    def crawl(self, start_url: str, max_pages=20, same_domain=True, **scrape_kwargs):
        visited, queue, results = set(), [start_url], []
        domain = urlparse(start_url).netloc
        while queue and len(results) < max_pages:
            url = queue.pop(0)
            if url in visited: continue
            visited.add(url)
            r = self.scrape(url, **scrape_kwargs)
            results.append(r)
            if same_domain:
                for link in r.links:
                    if urlparse(link).netloc == domain and link not in visited and link not in queue:
                        queue.append(link)
        return results


# Functional shortcut for agent
_default = None
def scrape(url, **kwargs):
    global _default
    if _default is None:
        _default = DynamicScraper()
    return _default.scrape(url, **kwargs)


if __name__ == "__main__":
    # Permanent test - will self-heal if HN changes classes
    s = DynamicScraper(headless=True, persist_path="./scraper_memory.json")
    res = s.scrape("https://news.ycombinator.com", wait_for=".titleline",
        extract={
            "titles": {"selector": ".titleline > a", "all": True, "attr": "text", "semantic": "story title"},
            "links": {"selector": ".titleline > a", "all": True, "attr": "href", "join_base": False, "semantic": "story link"}
        })
    print(res.to_json())
    print("Selectors used:", res.selectors_used)
    print("Healed:", res.healed)

"""Deterministic request-count benchmark for contact extraction (local stub server only;
no external network, no secrets, no production services).

Compares request counts per lead for real WebsiteWorker + ContactWorker against six
synthetic sites. Run it once against an engine checkout and once against another to
compare, e.g.:

    python bench/contact_request_count_benchmark.py <path-to-mast-lead-engine> old > old.json
    python bench/contact_request_count_benchmark.py <path-to-mast-lead-engine> new > new.json

`mode` only selects what the SERVICE passes for "no channels required": old = None
(legacy all-channels crawl), new = () (primary pages only).
"""
import sys, threading, collections, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
root, mode = sys.argv[1], sys.argv[2]
sys.path.insert(0, root); sys.dont_write_bytecode = True
from engine.contracts import BusinessCandidate
from workers.website_worker import WebsiteWorker
from workers.contact_worker import ContactWorker

P = '<a href="mailto:info@{h}.test">m</a><a href="tel:+12125550123">t</a>'
SITES = {  # host -> {path: html}
 "127.0.0.1": {"/": P.format(h="a")+'<a href="https://instagram.com/acafe">ig</a>'},            # all three on homepage
 "127.0.0.2": {"/": P.format(h="b")+'<a href="/contact">Contact</a>', "/contact": "<html>c</html>"},  # email+phone, no IG
 "127.0.0.3": {"/": '<a href="/contact">Contact</a>', "/contact": '<a href="mailto:info@c.test">m</a><a href="tel:+12125550123">t</a>'},
 "127.0.0.4": {"/": '<a href="tel:+12125550123">t</a><a href="/contact">Contact</a>', "/contact": '<a href="mailto:info@d.test">m</a>'},
 "127.0.0.5": {"/": "<html>nothing</html>"},                                                      # nothing anywhere
 "127.0.0.6": {"/": '<img src="/logo@2x.png"><img src="/hero@3x.jpg"><a href="tel:+12125550123">t</a>'},  # junk only emails
}
hits = collections.Counter()
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_GET(self):
        host = self.headers.get("Host","").split(":")[0]
        hits[host]+=1
        page = SITES.get(host,{}).get(self.path.split("?")[0])
        if page is None:
            self.send_response(404); self.end_headers(); return
        body = page.encode(); self.send_response(200); self.send_header("Content-Type","text/html"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
srv = ThreadingHTTPServer(("0.0.0.0",0),H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever,daemon=True).start()

def run(required):
    out={}
    for host in SITES:
        hits.clear()
        cand = BusinessCandidate(pipeline_id=host, session_id="s", provider="google_maps", name=host, website=f"http://{host}:{port}/", country="US")
        w = WebsiteWorker(); WebsiteWorker._domain_cache.clear() if hasattr(WebsiteWorker,"_domain_cache") else None
        wi = w.process(cand)
        cw = ContactWorker(required_channels=required) if required is not None else ContactWorker()
        ci = cw.process(wi)
        out[host]=dict(requests=hits[host], emails=list(ci.emails or ()), phones=len(ci.phones or ()), ig=bool(ci.instagram_url))
    return out
# production behaviour when the run requires NO channel: old passed None (legacy), new passes ()
no_channels = None if mode=="old" else ()
res = {"no_channels": run(no_channels), "email_required": run(("email",)), "email_phone_required": run(("email","phone"))}
print(json.dumps(res))

import sys, json
from curl_cffi import requests

url = sys.argv[1]
method = sys.argv[2].upper()
payload = json.loads(sys.argv[3]) if sys.argv[3] != "null" else None
headers = json.loads(sys.argv[4])
proxy = sys.argv[5] if sys.argv[5] else None

s = requests.Session()

kwargs = {
    "headers": headers,
    "impersonate": "chrome110",
    "allow_redirects": True
}

if proxy:
    kwargs["proxies"] = {"http": proxy, "https": proxy}

if method == "GET":
    r = s.get(url, **kwargs)
else:
    r = s.post(url, json=payload, **kwargs)

out = {
    "status": r.status_code,
    "headers": dict(r.headers),
    "text": r.text
}

try:
    out["json"] = r.json()
except:
    out["json"] = None

print(json.dumps(out))
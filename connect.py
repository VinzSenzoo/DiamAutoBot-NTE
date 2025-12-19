import sys, json, os
from curl_cffi import requests

def main():
    try:
        raw_payload = sys.argv[1]
        payload = json.loads(raw_payload)
    except Exception as e:
        print(json.dumps({"error": f"invalid_payload: {e}"}))
        return

    proxy = None
    if len(sys.argv) > 2 and sys.argv[2] and sys.argv[2] != "null":
        proxy = sys.argv[2]

    impersonate = None
    if len(sys.argv) > 3 and sys.argv[3]:
        impersonate = sys.argv[3]

    headers = {
        "Accept": "application/json, text/plain, */*",
        "Origin": "https://campaign.diamante.io",
        "Referer": "https://campaign.diamante.io/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    }

    s = requests.Session()
    try:
        kwargs = {}
        if impersonate:
            kwargs["impersonate"] = impersonate
        if proxy:
            kwargs["proxies"] = {"http": proxy, "https": proxy}

        r = s.post("https://campapi.diamante.io/api/v1/user/connect-wallet",
                   json=payload,
                   headers=headers,
                   allow_redirects=True,
                   **kwargs)

        out = {
            "status_code": r.status_code,
            "headers": dict(r.headers),
            "text": r.text
        }
        try:
            out["json"] = r.json()
        except Exception:
            out["json"] = None

        print(json.dumps(out))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
# Isolated M7 RSS acceptance settings. Contains no credentials.
CASTLOOP="[LOCAL_TEST_ROOT]/bin/castloop-linux-x64-5413fba"
WORKSPACE="[LOCAL_TEST_ROOT]/workspaces/rss-20261012-run1"
IMPORT_DIR="[LOCAL_TEST_ROOT]/imports/rss-20261012-run1"
EVIDENCE="[LOCAL_TEST_ROOT]/evidence/rss-import-20261012-run1"
SERVICE_ID="rsstest-1012-r1"
BUCKET_NAME="castloop-rss-20261012-run1"
DOMAIN_HOST="castloop-rss-r1.otftalk.com"
DOMAIN_BASE="https://$DOMAIN_HOST"
export WORKSPACE EVIDENCE SERVICE_ID BUCKET_NAME DOMAIN_HOST
umask 077
if [[ -f "$EVIDENCE/dns-proxy-active" ]]; then
  TEST_DNS_PROXY_URL="$(jq -er '.proxy_url' "$EVIDENCE/dns-proxy-ready.json")"
  [[ "$TEST_DNS_PROXY_URL" =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || return 1
  export HTTPS_PROXY="$TEST_DNS_PROXY_URL" https_proxy="$TEST_DNS_PROXY_URL"
  export NO_PROXY="api.cloudflare.com,.workers.dev,localhost,127.0.0.1" no_proxy="api.cloudflare.com,.workers.dev,localhost,127.0.0.1"
fi

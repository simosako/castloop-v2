# Existing RSS run1 environment, new formal CLI/Worker. No credentials.
source [LOCAL_TEST_ROOT]/test-env-rss-run1.sh
CASTLOOP=[LOCAL_TEST_ROOT]/bin/castloop-linux-x64-a19efb4
EVIDENCE=[LOCAL_TEST_ROOT]/evidence/rss-import-retest-a19efb4
export EVIDENCE
export RSS_RETEST_EVIDENCE="$EVIDENCE"

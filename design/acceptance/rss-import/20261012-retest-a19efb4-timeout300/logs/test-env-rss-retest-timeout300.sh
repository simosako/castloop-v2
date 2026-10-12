# Test-only CLI; Worker remains the deployed a19efb4 build. No credentials.
source [LOCAL_TEST_ROOT]/test-env-rss-run1.sh
CASTLOOP=[LOCAL_TEST_ROOT]/bin/castloop-linux-x64-a19efb4-timeout300
EVIDENCE=[LOCAL_TEST_ROOT]/evidence/rss-import-retest-a19efb4-timeout300
export EVIDENCE
export RSS_RETEST_EVIDENCE="$EVIDENCE"
export RSS_RETEST_SAMPLE_ONLY=1

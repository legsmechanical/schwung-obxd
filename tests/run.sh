#!/usr/bin/env bash
# Compile and run every tests/test_*.cpp natively. No Docker.
# OBXD_UPDATE_GOLDEN=1 tests/run.sh  -> regenerate golden baselines instead of asserting.
set -u
cd "$(dirname "$0")/.." || exit 2   # repo root (schwung-obxd/)

CXX="${CXX:-clang++}"
FLAGS="-std=c++14 -Isrc/dsp -Itests/harness -Wall -Wno-unused-function -g"
OUT="/tmp/obxd-tests"
mkdir -p "$OUT" tests/baseline

pass=0; fail=0
shopt -s nullglob
for t in tests/test_*.cpp; do
    name="$(basename "$t" .cpp)"
    bin="$OUT/$name"
    log="$OUT/$name.build.log"
    if ! $CXX $FLAGS "$t" -o "$bin" -lm 2> "$log"; then
        echo "BUILD FAIL: $name"; cat "$log"; fail=$((fail+1)); continue
    fi
    if "$bin"; then echo "PASS: $name"; pass=$((pass+1)); else echo "FAIL: $name"; fail=$((fail+1)); fi
done
echo "---"
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]

#!/bin/sh
# Copies the shared sample server state from core/ into UsualMailKit, which bundles it for previews and
# tests. Run it whenever core/fixtures/sample.json changes; SampleFreshnessTests fails until you do.
set -eu
cd "$(dirname "$0")/.."

cp ../core/fixtures/sample.json Packages/UsualMailKit/Sources/UsualMailKit/Resources/sample.json
echo "Copied core/fixtures/sample.json into UsualMailKit."

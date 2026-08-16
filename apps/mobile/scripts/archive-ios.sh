#!/bin/sh
set -eu

: "${FMR_IOS_DEVELOPMENT_TEAM:?Set FMR_IOS_DEVELOPMENT_TEAM to the Apple Developer Team ID}"
case "$FMR_IOS_DEVELOPMENT_TEAM" in
  *[!A-Z0-9]*)
    echo 'FMR_IOS_DEVELOPMENT_TEAM must be a 10-character uppercase Team ID' >&2
    exit 2
    ;;
esac
if [ "${#FMR_IOS_DEVELOPMENT_TEAM}" -ne 10 ]; then
  echo 'FMR_IOS_DEVELOPMENT_TEAM must be a 10-character uppercase Team ID' >&2
  exit 2
fi

mobile_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
archive_path=${FMR_IOS_ARCHIVE_PATH:-"$mobile_root/ios/App/output/FeelMyRythm.xcarchive"}

set -- \
  -project "$mobile_root/ios/App/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  DEVELOPMENT_TEAM="$FMR_IOS_DEVELOPMENT_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  clean archive

if [ "${FMR_IOS_ALLOW_PROVISIONING_UPDATES:-0}" = "1" ]; then
  set -- -allowProvisioningUpdates "$@"
fi

xcodebuild "$@"

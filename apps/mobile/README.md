# FeelMyRythm native shell

`ios/`와 `android/`는 모바일 전용 상대경로 빌드인 `web/`을 감싸는 Capacitor 8 네이티브 프로젝트다. `sync`는 Vite `mobile` 모드로 웹을 다시 빌드하고 자산 참조를 검증한 뒤 두 플랫폼에 동기화한다.

```sh
pnpm sync
```

## Deep links

두 플랫폼 모두 다음 방 초대 주소를 앱의 `/session/:roomId` 경로로 전달한다. 인증·비밀번호 재설정 메일의 HTTPS `/feelmyrythm/login#…` 링크와 Google-only 탈퇴 확인 메일의 정확한 `/feelmyrythm/settings#accountDeleteToken=…` 링크도 앱이 설치되어 있으면 각각 `/login#…`, `/settings#…`으로 전달하고, 설치되어 있지 않으면 웹에서 그대로 완료한다. credential route는 query와 알 수 없는/복수 fragment key를 거부한다.

- Custom URL: `feelmyrythm://session/<room-uuid>`
- Universal/App Link: `https://bonifacio.work/feelmyrythm/session/<room-uuid>`
- Auth completion: `https://bonifacio.work/feelmyrythm/login#<purpose-token>`
- Account deletion proof: `https://bonifacio.work/feelmyrythm/settings#accountDeleteToken=<token>`
- Custom deletion proof: `feelmyrythm://settings#accountDeleteToken=<token>`

iOS Universal Links가 검증되려면 `https://bonifacio.work/.well-known/apple-app-site-association`에 실제 Apple Team ID와 bundle ID `work.bonifacio.feelmyrythm`을 사용한 연결 정보가 있어야 한다. 경로 범위는 `/feelmyrythm/session/*`, 정확한 `/feelmyrythm/login`, 정확한 `/feelmyrythm/settings`로 제한한다. `/settings/*` 같은 확장 범위는 허용하지 않는다.

Android App Links가 검증되려면 `https://bonifacio.work/.well-known/assetlinks.json`에 package name `work.bonifacio.feelmyrythm`과 실제 release signing certificate SHA-256 fingerprint를 게시해야 한다. `assetlinks.json`은 그 앱 identity만 위임하고, manifest는 방 초대와 정확한 `/feelmyrythm/login`·`/feelmyrythm/settings`만 허용한다. 로컬 keystore와 인증서 fingerprint는 저장소에 커밋하지 않는다.

시뮬레이터 또는 연결된 테스트 기기에서는 다음과 같이 custom URL을 확인할 수 있다.

```sh
xcrun simctl openurl booted 'feelmyrythm://session/test-room'
adb shell am start -W -a android.intent.action.VIEW -d 'feelmyrythm://session/test-room' work.bonifacio.feelmyrythm
adb shell am start -W -a android.intent.action.VIEW -d 'https://bonifacio.work/feelmyrythm/settings#accountDeleteToken=test-token' work.bonifacio.feelmyrythm
```

## Audio and wake behavior

- iOS는 `AVAudioSession.Category.playback`을 활성화해 무음 스위치와 독립적으로 재생하고, `UIBackgroundModes/audio`를 선언한다.
- iOS와 Android 모두 튜너용 마이크 권한을 선언한다. 권한은 WebView가 실제로 마이크를 요청할 때 사용자에게 표시된다.
- Android의 하드웨어 볼륨 키는 music stream을 제어한다.
- `@capacitor-community/keep-awake`는 재생 중 화면 꺼짐을 막고 정지 시 다시 허용한다. Android 구현은 `FLAG_KEEP_SCREEN_ON`을 사용하므로 별도 `WAKE_LOCK` 권한이 필요하지 않다.
- 현재 오디오 엔진은 Web Audio다. OS가 앱을 완전히 background/suspend한 상태의 지속 재생은 정적 설정만으로 보장할 수 없다. 문서 설계대로 실기기 검증에서 미달할 때에만 `NativeAudioEngine`과 Android foreground media service를 추가한다.

## Authentication storage

- 브라우저 빌드는 기존 `localStorage` 키를 유지한다.
- 네이티브 빌드는 인증 세션을 iOS Keychain의 `AfterFirstUnlockThisDeviceOnly` 항목과 Android Keystore AES-GCM 키로 암호화한 앱 전용 저장소에 보관한다.
- Android 앱은 `allowBackup=false`와 Android 12+ `dataExtractionRules` 양쪽에서 cloud/D2D 전송을 차단하며, 네이티브 시작 시 이전 버전의 WebView `localStorage` 인증 키를 제거한다.
- Capacitor WebView에서는 Google Identity Services 웹 버튼을 노출하지 않는다. 네이티브 Sign in with Apple/Google 흐름을 별도로 구현하기 전에는 이메일 소유권 인증만 사용한다.

## Release signing

서명 파일과 비밀번호는 저장소에 두지 않는다. Android App Bundle은 다음 네 값을 모두 환경으로 주입해야 하며, 하나라도 없으면 `bundleRelease`가 실패한다.

```sh
FMR_ANDROID_KEYSTORE_PATH=/absolute/path/to/release.keystore \
FMR_ANDROID_KEYSTORE_PASSWORD='…' \
FMR_ANDROID_KEY_ALIAS='…' \
FMR_ANDROID_KEY_PASSWORD='…' \
pnpm bundle:android
```

iOS archive는 Team ID를 환경으로 주입한다. 자동 provisioning 갱신이 필요한 CI에서만 `FMR_IOS_ALLOW_PROVISIONING_UPDATES=1`을 추가한다.

```sh
FMR_IOS_DEVELOPMENT_TEAM='XXXXXXXXXX' pnpm archive:ios
```

실제 값, `.p12`, provisioning profile, keystore, `google-services.json`은 플랫폼 `.gitignore`로 차단한다.

## Release checks

스토어 제출 전에는 실제 signing 설정을 로컬 또는 CI secret으로 주입하고 다음을 확인한다.

1. iOS/Android에서 custom link와 verified HTTPS link가 같은 방을 열고, `/login` 인증 링크와 `/settings` 탈퇴 proof 링크가 정확한 화면을 연 뒤 fragment를 즉시 제거한다.
2. iOS 무음 스위치가 켜져 있어도 클릭이 재생된다.
3. 재생 중 Keep-Awake가 화면 잠금을 막고 정지 후 원상 복구된다.
4. 잠금·백그라운드·전화 인터럽트 후 타임라인 동기 오차를 실기기에서 재측정한다.
5. 마이크 거부·허용 상태 모두에서 튜너가 안전하게 동작한다.
6. `https://bonifacio.work/feelmyrythm/privacy`를 App Store·Play Console 개인정보 처리방침 URL로 등록하고 실제 운영자 연락처가 수신되는지 확인한다.
7. `https://bonifacio.work/feelmyrythm/delete-account`를 Play Console 외부 계정 삭제 URL로 등록하고 앱 안의 설정 경로와 웹 경로 모두에서 삭제를 완료한다.
8. iOS에서 제3자 로그인을 다시 제공하려면 App Review Guideline 4.8을 충족하는 동등 로그인(일반적으로 Sign in with Apple)을 먼저 추가한다.

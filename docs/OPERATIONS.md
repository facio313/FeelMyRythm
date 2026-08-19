# FeelMyRythm 운영 준비 및 검증

이 문서는 실제 계정·인증서·기기·인프라가 필요한 마지막 검증을 재현 가능한 순서로 묶는다. 저장소의 자동 테스트가 통과해도 이 절차의 결과를 대신하지는 않는다. RPi가 중단된 동안에도 1–5단계는 독립적으로 준비할 수 있다.

## 1. 공개 모바일 연결 파일

Android release 인증서 SHA-256은 다음 bundle 명령에서도 실제 keystore alias와 대조된다. Team ID와 fingerprint를 동일하게 사용해 AASA와 `assetlinks.json`을 생성한다.

```sh
FMR_IOS_DEVELOPMENT_TEAM='XXXXXXXXXX' \
FMR_ANDROID_CERT_SHA256='AA:BB:CC:…' \
pnpm --filter @feelmyrythm/mobile generate:association-files -- \
  --output-dir /safe/staging/well-known
```

운영 프록시는 생성된 파일을 다음 위치에 redirect 없이 제공해야 한다.

| URL | 파일 | 필수 응답 |
|---|---|---|
| `https://bonifacio.work/.well-known/apple-app-site-association` | `apple-app-site-association` | 200, JSON, 인증 불필요 |
| `https://bonifacio.work/.well-known/assetlinks.json` | `assetlinks.json` | 200, JSON, 인증 불필요 |

AASA 경로는 `/feelmyrythm/session/*`, 정확한 `/feelmyrythm/login`, 정확한 `/feelmyrythm/settings`만 포함한다. preflight는 더 넓은 `/feelmyrythm/*` 위임도 실패시킨다.

## 2. S3 계약

브라우저가 presigned POST로 staging object를 직접 올리고 presigned GET으로 악보를 읽으므로 bucket CORS에는 공개 web origin의 `POST`, `GET`, `Content-Type`이 필요하다. 예시는 다음과 같다. 실제 provider 문법과 보안 정책에 맞게 더 좁힐 수 있지만 origin을 `*`로 넓힐 이유는 없다.

```json
[
  {
    "AllowedOrigins": ["https://bonifacio.work"],
    "AllowedMethods": ["GET", "POST"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

앱의 durable outbox worker가 정상 삭제를 책임진다. 별도로 `staging/` prefix에는 provider lifecycle expiration을 둬서 클라이언트가 complete하지 못하고 장기간 남은 객체에 대한 최종 안전망을 만든다. lifecycle 기간은 `FMR_LATE_UPLOAD_GUARD_SECONDS`보다 길어야 늦은 PUT guard와 충돌하지 않는다. 기본 guard가 1일이므로 2일 이상을 권장한다.

IAM 주체에는 전용 bucket/prefix의 presign, head, copy, get, put, delete와 bucket CORS/lifecycle 조회 권한만 준다. 다른 bucket이나 계정 전체 권한은 주지 않는다.

## 3. PostgreSQL·Redis·SMTP·S3·공개 URL preflight

기본 preflight는 외부 상태를 변경하지 않는다. production `.env`를 검증한 다음 아래를 확인한다.

- PostgreSQL 연결 및 현재 Alembic head
- Redis 인증 `PING`
- SMTP TLS/인증과 `NOOP`
- S3 bucket 접근, CORS, `staging/` lifecycle
- 공개 `/api/health`
- 실제 signed identity가 들어간 AASA와 `assetlinks.json`

```sh
pnpm production:preflight -- \
  --env-file /absolute/path/to/production.env \
  --ios-team-id XXXXXXXXXX \
  --android-cert-sha256 'AA:BB:CC:…'
```

JSON의 모든 check가 `passed`여야 한다. provider 예외는 credential이나 signed URL이 로그에 섞이지 않도록 예외 종류만 출력한다.

실제 부작용은 명시적으로 요청한 경우에만 수행한다.

```sh
# 전용 preflight/ key 하나를 put → head → delete
pnpm production:preflight -- --env-file /absolute/path/to/production.env \
  --ios-team-id XXXXXXXXXX --android-cert-sha256 'AA:BB:CC:…' --exercise-s3

# 한 통의 실제 전달 테스트 메일
pnpm production:preflight -- --env-file /absolute/path/to/production.env \
  --ios-team-id XXXXXXXXXX --android-cert-sha256 'AA:BB:CC:…' \
  --send-test-email operator@example.com
```

association 파일을 아직 게시하기 전의 인프라 점검에서만 `--skip-association`을 쓸 수 있다. release 승인용 최종 결과에서는 skip을 허용하지 않는다.

## 4. 공용 `cksDB` backup/restore rehearsal

앱 stack은 공용 DB container·network·volume을 만들거나 재시작하지 않는다. DB 운영자가 다음 순서를 별도 staging DB에서 실연한다.

1. 전용 FeelMyRythm DB를 PostgreSQL custom format으로 backup하고 파일 hash·PostgreSQL major version·Alembic revision을 기록한다.
2. production과 같은 major version의 격리 staging instance에 새 DB/user를 만든다.
3. backup을 restore한 뒤 전용 앱 계정으로 연결한다. 공용의 다른 DB나 role은 대상에 포함하지 않는다.
4. `alembic upgrade head`와 production preflight의 PostgreSQL check를 실행한다.
5. 핵심 row count, 최근 Score object key 표본, 로그인·악보 목록 read-only smoke를 확인한다.
6. 목표 복구 시간과 실패 지점을 기록하고 backup 보존·암호화 정책을 확인한다.

운영 DB에 `alembic downgrade`를 즉흥 실행하지 않는다. schema rollback이 필요한 release는 이전 호환 app image와 명시적 forward-fix migration을 우선하며, 복구가 필요한 경우 위에서 검증한 backup을 새 instance에 restore한 뒤 전환한다.

## 5. 메일·OAuth·abuse 경계

SMTP preflight의 auth 성공은 inbox 전달을 보장하지 않는다. 실제 test recipient에서 가입·재발급·reset·Google-only 탈퇴 확인 메일의 도착, 링크 1회성, 만료, 반송과 spam 분류를 확인한다. SPF, DKIM, DMARC, sender domain, provider quota는 운영 provider에서 점검한다.

브라우저 Google OAuth의 authorized JavaScript origin과 redirect/credential origin에는 실제 `https://bonifacio.work`만 등록한다. server와 web build에는 같은 web client ID를 넣는다. Capacitor WebView는 이 web OAuth를 노출하지 않는다.

앱은 임의의 `X-Forwarded-For`를 신뢰하지 않는다. 외부 trusted proxy/CDN은 client가 보낸 forwarding header를 제거하고 자체 연결 정보로 다시 작성해야 한다. signup, verification resend, login, password reset, account deletion mail endpoint에 IP·ASN 기반 rate limit과 provider quota를 둔다. CAPTCHA를 도입한다면 token 검증은 trusted edge 또는 별도 서버 adapter에서 수행하고, 실패를 계정 존재 여부가 드러나는 응답으로 바꾸지 않는다.

## 6. 서명 archive와 실기기 오디오 matrix

CI는 unsigned iOS simulator와 Android debug native shell을 compile한다. release 판정에는 실제 signing identity가 필요하다.

```sh
FMR_IOS_DEVELOPMENT_TEAM='XXXXXXXXXX' pnpm --filter @feelmyrythm/mobile archive:ios

FMR_ANDROID_KEYSTORE_PATH=/absolute/release.keystore \
FMR_ANDROID_KEYSTORE_PASSWORD='…' \
FMR_ANDROID_KEY_ALIAS='…' \
FMR_ANDROID_KEY_PASSWORD='…' \
FMR_ANDROID_CERT_SHA256='AA:BB:CC:…' \
pnpm --filter @feelmyrythm/mobile bundle:android
```

clean device에 설치한 뒤 cold/warm Universal/App Link, secure session 재설치·backup 격리, iOS 무음 스위치, 화면 잠금, background, 전화·알림 interrupt, Android 제조사 절전, audio focus, notification stop, microphone 거부/허용, haptic을 확인한다.

30분 WAV와 2–3대 공통 stereo/multichannel 녹음을 [오디오 품질 도구](../scripts/audio_quality/README.md)로 분석한다. 내장/유선 출력에서 누락·중복 click이 없고 RMS jitter·장기 drift가 허용 범위이며 기기 간 offset 절댓값이 10ms 이하여야 한다. Bluetooth는 물리 지연 때문에 이 합격 기준에서 제외하고 별도 calibration UX로 관리한다.

## 7. RPi 복구 후 마지막 단계

RPi가 복구되기 전에는 여기부터 완료로 표시하지 않는다. Validate가 성공한 정확한 main commit SHA의 immutable ARM64 image만 publish하고, forced command가 임의 명령을 거부하는지, health 실패 시 이전 SHA로 복귀하는지, `cksDB` container/network/data에 변화가 없는지 확인한다. 서버 장애는 앞 단계의 네이티브 compile·association 생성·provider preflight 구현을 생략하는 근거가 아니다.

Validate의 JavaScript job은 `@playwright/test`와 같은 버전의 digest 고정 Microsoft Playwright 이미지에서 실행하며, runner마다 `playwright install --with-deps`를 다시 수행하지 않는다. server·protocol job은 runtime image와 같은 Python patch를 먼저 설치하고 그 patch를 지원하는 동일한 uv 버전으로 lockfile을 동기화한다. 저장소 루트의 `.env.example`·`docker-compose.prod.yml`을 읽는 `repository_contract` 테스트는 전체 checkout을 가진 server job에서 반드시 실행한다. `apps/server`만 컨텍스트로 받는 ARM64 서버 이미지의 test target은 이 두 저장소 계약만 제외하고 나머지 서버 suite를 다시 실행한다. Android·iOS job은 각 runner의 clean checkout에서 `pnpm build:workspace-libs`를 선행한 뒤 Capacitor sync와 native compile을 수행한다. Android job은 Gradle/Capacitor의 source level과 일치하는 Temurin JDK 21 및 고정 Android platform·NDK·CMake를 사용한다. main Validate가 실패하면 후속 `Build and deploy to RPi5` 실행이 `skipped`되는 것이 정상이며, 이 경우 운영 반영으로 보고하지 않는다.

배포 완료 판정에는 다음 세 증거가 모두 필요하다.

1. main의 `Validate`가 정확한 대상 SHA로 성공한다.
2. 같은 SHA의 `Build and deploy to RPi5`에서 publish와 restricted deployment job이 모두 성공한다.
3. 공개 health와 HTML/asset 응답이 새 배포 이후 값으로 바뀌고, 핵심 경로 smoke가 통과한다.

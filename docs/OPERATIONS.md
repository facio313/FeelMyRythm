# FeelMyRythm 운영 준비 및 검증

## 현재 중앙 계정·단일 서버 로컬 저장 운영

`bonifacio.work` 배포는 단일 서버 운영 자세로 `production`, `PORTFOLIO_BRANCH=main`, `PORTFOLIO_AUTH_MODE=sso`, `FMR_DEPLOYMENT_PROFILE=managed_local_sso`를 명시한다. 이 프로필은 S3·앱 SMTP를 아직 못 갖춘 임시 우회가 아니라 중앙 계정과 서버 전용 local object volume을 결합한 지원 구성이다. `scripts/portfolio-auth-mode.sh check`가 실패하거나 canonical 값이 빠진 packaged/container 실행은 중단하며 development fallback을 사용하지 않는다.

- `FMR_STORAGE_BACKEND=local`, `FMR_LOCAL_UPLOADS_DIR=/data/uploads`와 사전 생성된 external named volume `feelmyrythm-fmr-uploads`를 사용한다. runtime image가 UID/GID 10001 소유의 mount point를 제공한다. External 선언 때문에 Compose는 이 volume을 만들거나 `down -v`로 삭제하지 못하며, volume이 없으면 배포가 fail-closed한다.
- DB에는 `/data/uploads`나 Docker host의 mountpoint를 기록하지 않는다. `Score.storage_key`/`staging_key`가 backend-neutral 상대 object key를, `StorageDeletionJob`이 삭제 outbox를 맡는다. 현재 악보 파일 범위에서는 이 두 테이블이 권위 파일 관리 모델이므로 중복 `files` 테이블을 추가하지 않는다.
- 공개 register, verification resend, password reset, mail 기반 account-delete challenge는 닫는다. SMTP sender 대신 signed URL을 출력하지 않는 disabled sender를 사용한다.
- 운영 사용자 계정은 Bonifacio 관리자에서 관리하고 첫 trusted SSO exchange가 앱 row를 verified·active·SSO-only 상태로 자동 provision한다. 앱 DB에 운영 password를 seed/reset하는 bootstrap 경로는 두지 않는다.
- `bonifacio.work` browser 배포는 canonical `main/sso`에 맞춰 legacy adapter `FMR_SSO_ENABLED=true`, `VITE_FMR_SSO_ENABLED=true`, `VITE_FMR_MANAGED_LOCAL_SSO=true`도 함께 고정한다. 어느 adapter든 canonical mode와 다르면 server startup 또는 web build를 실패시킨다. `/api/auth/sso`는 stable `Remote-User` subject를 먼저 찾고, 미연결 unique email owner를 한 번 link하거나 새 중앙 identity를 storage profile과 무관하게 verified active 앱 user로 provision한다. subject와 email이 서로 다른 row를 가리키면 409로 실패한다. 웹은 같은 tab에서 SSO bootstrap을 single-flight로 실행하고, 저장된 atomic app session이 있으면 먼저 `/api/users/me`와 필요 시 refresh를 호출해 현재 edge subject 아래 검증한다. 권위 있는 401일 때만 `/api/auth/sso`를 다시 교환하며 일반 API 사용 중 refresh 401도 app을 차단한 채 현재 identity로 rebootstrap한다. network/5xx/conflict는 anonymous 앱으로 통과시키지 않고 재시도 화면에 머문다. local login·Google·email recovery·account deletion은 403으로 닫는다. logout은 앱 refresh revoke와 local storage cleanup을 기다리되 3초 bounded abort 뒤 중앙 SSO session도 끝낸다.
- 앱 전용 edge secret은 `openssl rand -hex 48` 같은 CSPRNG로 생성해 secret 본문에 trailing newline 없이 저장한다. rootless host 파일은 작은 regular file, `cks:cks`, mode 0640으로 만들고 경로만 Compose interpolation용 `FMR_SSO_EDGE_SECRET_FILE`에 둔다. Compose는 서버를 비-root UID 10001, GID 0으로 실행하며 read-only bind는 container의 `/run/secrets/fmr_sso_edge_secret`에서 `root:root` mode 0640으로 보여야 한다. 서버는 owner/group/mode와 effective GID 0을 시작 시 검증한다. secret 본문을 Compose·`.env`·nginx access log·CI output에 넣지 않는다. 환경변수 `FMR_SSO_EDGE_SECRET`은 개발/격리 테스트 fallback일 뿐 운영 기본이 아니다.
- outer trusted proxy는 client가 보낸 `Remote-*`와 `X-Portfolio-Edge-Secret`을 제거·덮어쓰고, auth_request 결과의 subject/email/name/groups와 위 파일의 앱 전용 secret을 loopback fmrWeb에 전달한다. 내부 nginx는 API와 WebSocket upstream 모두에 이 header를 명시 전달한다. 서버는 SSO exchange, 모든 bearer HTTP API, refresh, logout과 room·annotation WebSocket의 first-frame token 인증에서 secret, `Remote-User == User.sso_subject`, canonical group prefix를 함께 검사한다. 허용 group은 whitespace 없는 exact `user`, `user,developer`, `user,developer,admin`뿐이고 일반 접근/운영 inventory/admin cleanup에 각각 user/developer/admin 최소 역할을 적용한다. 자동 provision을 켠 현재 계약에서는 중앙 `user` group이 곧 FeelMyRythm 이용 허가이므로 중앙 provider가 일반 포트폴리오 계정 전체가 아니라 앱 허가 대상에게만 이 group을 발급해야 한다. `/api/health`와 명시적 public HTTP 경로만 예외다.
- SSO startup은 password 또는 Google subject가 남은 User의 credential을 비우고 auth generation을 올린 뒤 해당 refresh row를 제거한다. revoked/expired refresh row도 멱등 제거하며 User/domain row는 보존한다. bearer와 trusted developer headers를 함께 요구하는 `GET /api/operations/auth-inventory`는 aggregate count만 반환한다. admin을 요구하는 `POST /api/admin/auth-cleanup`은 `{ "confirmPurgeActiveRefreshSessions": true }`가 있어야 credential 연관·stale row에 이어 남은 active refresh row도 모두 제거하고 처리 count만 반환한다. 기존 access JWT는 자체 만료까지 유효하고 다음 refresh부터 실패한다. 운영에서 실행 전 inventory를 기록하고 response나 log에 email, subject, token hash를 추가하지 않는다.
- target preflight는 SMTP를 명시적으로 skipped로 기록하고 local upload root의 runtime 접근성을 확인한다. 이 결과는 off-host object backup 완료를 뜻하지 않는다.
- web release는 `VITE_FMR_MANAGED_LOCAL_SSO=true`로 빌드한다. topbar 정보 버튼의 `현재 운영 구성` dialog는 자동으로 열리지 않으며 적용된 local volume/SSO와 조건부 S3·backup·mobile association·OMR 범위를 구분한다.

새 운영 계정은 중앙 관리자 화면에서 만들고 trusted exchange로 앱에 투영한다. 앱 DB에 운영 비밀번호를 만들거나 비밀번호·edge secret을 채팅·CI log·shell argument로 넘기지 않는다.

첫 배포 전에 운영자 권한으로 아래 volume을 한 번만 만든다. 실제 host data-root 경로는 rootless Docker 설정에 따라 달라지므로 DB·Compose에 `/var/lib/docker/...` 같은 값을 하드코딩하지 않는다.

```sh
docker volume create feelmyrythm-fmr-uploads
docker volume inspect feelmyrythm-fmr-uploads
```

향후 다중 서버 또는 off-host object storage가 필요해 standard/S3로 전환할 때만 local volume snapshot → S3 bucket/CORS/lifecycle/credential 준비 → 같은 object key와 size/hash 이관 검증 → `FMR_DEPLOYMENT_PROFILE=standard` 및 S3 설정 전환 → S3 preflight 순서를 따른다. SSO를 유지한다면 앱 SMTP는 여전히 설정하지 않는다. local-auth와 public email workflow를 별도로 열기로 결정한 경우에만 SMTP domain/TLS/auth와 실제 수신 시험을 추가한다.

| 항목 | 현재 판정 | 필요해지는 시점 |
|---|---|---|
| S3 호환 저장소 | 선택·연기 가능 | 다중 server, RPi와 분리된 객체 수명, browser direct transfer가 필요할 때 |
| 앱 SMTP | SSO mode에서는 사용 금지 | FeelMyRythm이 local account 가입·reset 메일을 다시 소유할 때 |
| server-volume off-host backup | 권장, 현재 기능 비차단 | 업로드 악보를 장애 후에도 보존한다고 약속할 때 |
| AASA/`assetlinks.json` | 연기 가능 | 서명된 iOS/Android 앱의 Universal/App Link를 출시할 때 |
| Audiveris | 연기 가능 | 선택적 PDF/image OMR 초안 기능을 운영에서 활성화할 때 |

External volume은 container 교체와 Compose 삭제 명령으로부터 파일 수명을 분리하지만 host disk 자체의 고장·분실까지 복구하는 backup은 아니다. 아직 보존을 약속하지 않는 시험 운영에서는 별도 backup/restore 자동화가 기능 gate가 아니며, 악보 보존이 중요해질 때 S3 도입 여부와 별개로 snapshot·restore rehearsal을 추가한다.

OMR은 PDF나 사진 악보를 읽어 마디 영역의 **초안**을 만드는 Optical Music Recognition 보조 기능이다. 정확도를 보장하지 않고 사용자가 미리 본 뒤 저장해야 하며, 수동 마디 매핑은 Audiveris 없이 계속 동작한다. 현재 Compose는 `FMR_OMR_ENABLED=false`이고 runtime image에 Audiveris를 넣지 않으므로, OMR을 실제로 제공하기로 결정할 때만 실행 파일·CPU/RAM·timeout·대표 악보 정확도를 검증한다.

이 문서는 실제 계정·인증서·기기·인프라가 필요한 마지막 검증을 재현 가능한 순서로 묶는다. 저장소의 자동 테스트가 통과해도 이 절차의 결과를 대신하지는 않는다. RPi가 중단된 동안에도 1–5단계는 독립적으로 준비할 수 있다.

## 1. 서명된 모바일 출시용 연결 파일

AASA와 `assetlinks.json`은 web/API 배포 조건이 아니다. 설치된 서명 앱이 `https://bonifacio.work/feelmyrythm/...` 링크를 Universal Link/App Link로 열게 할 때만 필요하다. 모바일 출시를 승인할 때 Android release 인증서 SHA-256을 실제 keystore alias와 대조하고 Team ID와 fingerprint로 파일을 생성한다.

이 연결 파일은 native 인증 구현을 대신하지 않는다. 현재 production mobile build에는 system browser의 중앙 SSO session을 WebView app session으로 교환하는 callback/bridge가 없으므로 signed mobile release 자체가 차단된다. 해당 bridge를 먼저 구현하고 account switch·logout까지 실기기에서 검증한 뒤 아래 association 파일을 release gate에 포함한다.

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

## 2. 선택적 S3 호환 저장소 계약

이 절은 S3 backend를 선택할 때만 적용된다. 현재 managed-local profile은 local upload API와 external volume만으로 동작한다. S3에서는 브라우저가 presigned POST로 staging object를 직접 올리고 presigned GET으로 악보를 읽으므로 bucket CORS에는 공개 web origin의 `POST`, `GET`, `Content-Type`이 필요하다. 예시는 다음과 같다. 실제 provider 문법과 보안 정책에 맞게 더 좁힐 수 있지만 origin을 `*`로 넓힐 이유는 없다.

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

## 3. PostgreSQL·Redis·선택 provider·공개 URL preflight

기본 preflight는 외부 상태를 변경하지 않는다. production `.env`를 검증한 다음 아래를 확인한다.

`bonifacio.work`의 제한 배포 Compose는 host port가 없는 전용 `fmrRedis`를 내부 network에 만들고 Redis URL을 고정한다. 이 host에서는 다른 앱의 Redis를 재사용하거나 `.env`로 Redis 주소를 덮어쓰지 않는다. 일반적인 별도 배포에서만 `.env`의 `FMR_REDIS_URL`을 명시한다.

- PostgreSQL 연결 및 현재 Alembic head
- Redis 인증 `PING`
- public app email workflow가 활성화된 경우에만 SMTP TLS/인증과 `NOOP`
- S3 backend인 경우 bucket 접근, CORS, `staging/` lifecycle; local backend인 경우 runtime upload root 접근
- 공개 `/api/health`
- signed mobile release 승인인 경우 실제 identity가 들어간 AASA와 `assetlinks.json`

```sh
# 현재 web/API 운영 점검: signed mobile association은 명시적으로 제외
pnpm production:preflight -- \
  --env-file /absolute/path/to/production.env \
  --skip-association

# signed mobile release 승인 점검
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

web/API 배포 또는 association 파일을 아직 게시하기 전의 인프라 점검에서는 `--skip-association`을 쓸 수 있다. signed mobile release 승인용 최종 결과에서만 skip을 허용하지 않는다.

RPi 제한 배포의 첫 target-image preflight는 migration을 실행하기 전에만 `--allow-database-behind`를 함께 사용한다. 이 flag는 현재 Alembic revision이 target head의 정확한 알려진 조상인 단일-head DB만 허용한다. 비어 있거나 unversioned인 DB, unknown/divergent revision, multi-head mismatch는 계속 실패한다. canary가 migration phase에 들어간 뒤의 preflight에는 이 flag를 절대 사용하지 않고 strict target-head 일치를 요구한다. RPi의 Redis DNS는 private Compose network 안에서만 해석되므로 이 검사는 host-side `pnpm`이 아니라 target `fmrServer` one-shot container에서 실행한다.

## 4. 공용 `cksDB` backup/restore rehearsal

앱 stack은 공용 DB container·network·volume을 만들거나 재시작하지 않는다. DB 운영자가 다음 순서를 별도 staging DB에서 실연한다.

1. 전용 FeelMyRythm DB를 PostgreSQL custom format으로 backup하고 파일 hash·PostgreSQL major version·Alembic revision을 기록한다.
2. production과 같은 major version의 격리 staging instance에 새 DB/user를 만든다.
3. backup을 restore한 뒤 전용 앱 계정으로 연결한다. 공용의 다른 DB나 role은 대상에 포함하지 않는다.
4. `alembic upgrade head`와 production preflight의 PostgreSQL check를 실행한다.
5. 핵심 row count, 최근 Score object key 표본, 로그인·악보 목록 read-only smoke를 확인한다.
6. 목표 복구 시간과 실패 지점을 기록하고 backup 보존·암호화 정책을 확인한다.

Alembic 도입 전 운영판이 만든 DB에는 `alembic_version`이 없다. 이 경우 root migration은 알려진 legacy signature만 한 transaction에서 revision schema로 변환한다. 기존 악보 DB row의 `stored_name`은 새 `storage_key`로 그대로 유지한다. local backend를 계속 쓰면 같은 external upload volume에서 key 존재와 size/hash 표본을 대조하고, S3로 전환할 때만 각 객체를 같은 key로 bucket에 복사한다. 알 수 없는 unversioned schema, legacy 객체 누락, 예상과 다른 row count가 하나라도 있으면 운영 DB를 stamp하거나 table을 수동 삭제하지 말고 backup에서 staging rehearsal을 다시 수행한다.

운영 DB에 `alembic downgrade`를 즉흥 실행하지 않는다. schema rollback이 필요한 release는 이전 호환 app image와 명시적 forward-fix migration을 우선하며, 복구가 필요한 경우 위에서 검증한 backup을 새 instance에 restore한 뒤 전환한다.

## 5. local-auth를 선택할 때의 메일·OAuth·abuse 경계

현재 SSO mode에서는 이 절의 앱 SMTP를 적용하지 않는다. 중앙 계정 가입·복구 메일은 중앙 SSO 운영 절차에서 검증한다. 향후 FeelMyRythm이 local-auth를 다시 제공할 때만 SMTP preflight를 수행하며, auth 성공만으로 inbox 전달을 보장하지 않는다는 점을 전제로 실제 test recipient에서 가입·재발급·reset·Google-only 탈퇴 확인 메일의 도착, 링크 1회성, 만료, 반송과 spam 분류를 확인한다. SPF, DKIM, DMARC, sender domain, provider quota는 운영 provider에서 점검한다.

브라우저 Google OAuth의 authorized JavaScript origin과 redirect/credential origin에는 실제 `https://bonifacio.work`만 등록한다. server와 web build에는 같은 web client ID를 넣는다. Capacitor WebView는 이 web OAuth를 노출하지 않는다.

앱은 임의의 `X-Forwarded-For`를 신뢰하지 않는다. 외부 trusted proxy/CDN은 client가 보낸 forwarding header를 제거하고 자체 연결 정보로 다시 작성해야 한다. signup, verification resend, login, password reset, account deletion mail endpoint에 IP·ASN 기반 rate limit과 provider quota를 둔다. CAPTCHA를 도입한다면 token 검증은 trusted edge 또는 별도 서버 adapter에서 수행하고, 실패를 계정 존재 여부가 드러나는 응답으로 바꾸지 않는다.

## 6. 서명 archive와 실기기 오디오 matrix

CI는 unsigned iOS simulator와 Android debug native shell을 compile한다. release 판정에는 실제 signing identity가 필요하다.

또한 production SSO mobile authentication bridge가 아직 미구현이므로 현재 compile 성공은 로그인 가능한 release artifact를 뜻하지 않는다. system-browser login, 일회용 credential exchange, native callback, secure storage와 logout을 구현·검증하기 전에는 archive를 배포하지 않는다.

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

RPi가 복구되기 전에는 여기부터 완료로 표시하지 않는다. Validate가 성공한 정확한 main commit SHA의 immutable ARM64 image만 publish한다. Validate와 deploy workflow는 checkout의 실제 source branch를 `PORTFOLIO_BRANCH`로 주입하고 resolver가 만든 mode를 이후 step에 전달한다. `dev`도 `dev/sso`로 ARM64 server/web image build와 runtime smoke를 완료하지만 registry push, latest/release 취급, 제한 SSH 운영 배포는 실행하지 않는다. main image build와 운영 Compose에는 `main/sso`가 모두 명시되어야 한다. 게시 전 스모크는 digest 고정 PostgreSQL과 Redis를 격리 네트워크에 띄워 준비 상태를 확인하고, 그 정확한 server/web image가 migration·Redis 연결·health·non-root/read-only 경계·nginx SPA/API proxy를 모두 만족할 때만 GHCR에 push한다. forced command가 임의 명령을 거부하는지 아래 순서를 지키는지 확인한다.

GitHub deploy job은 여러 저장소가 공유하는 host 전역 lock에서 최대 20분 대기할 수 있으므로 timeout을 40분으로 유지한다. 이 직렬화는 다른 Compose project가 동시에 변경되어 snapshot 검증이 무의미해지는 것을 막는다.

1. target server/web와 pinned Redis image를 준비하고 전용 Redis를 healthy로 만든다. Redis AOF rewrite를 위해 host의 `vm.overcommit_memory=1`을 지속 설정하며, named volume을 삭제하지 않는다.
2. FMR 이외의 모든 container name·ID를 snapshot한다.
3. target `fmrServer` one-shot container에서 `--allow-database-behind` pre-migration provider/revision preflight를 실행한다.
4. 전용 DB를 custom-format으로 backup하고 checksum을 기록한다.
5. 기존 서비스는 유지한 채 같은 env/network/default command의 target server canary를 `127.0.0.1:19175`에 기동한다. cleanup trap은 성공·실패 모두 canary를 제거한다.
6. canary health 후 strict target-head preflight를 실행하고 target server, target web 순서로 승격한다. 두 container의 실제 image ID를 요청 image와 각각 비교한다.
7. 내부·공개 health와 strict provider preflight를 다시 확인하고 비대상 container snapshot이 동일할 때만 revision을 기록한다.
8. edge SSO cookie로 `/api/auth/sso`를 교환해 기존 owner의 one-time subject link와 새 중앙 사용자의 auto-provision을 각각 확인한다. `/api/users/me`, refresh, logout과 room·annotation WebSocket join은 올바른 edge subject+secret+canonical groups에서만 성공하고 누락·오류 secret, empty/duplicate/unknown/non-prefix group, 다른 subject, subject/email 충돌은 401/409 또는 WS `4401`로 fail-closed여야 한다. user는 admin cleanup이 403, developer는 inventory만 성공, admin은 멱등 cleanup이 성공하는지 확인한다. local password login과 account deletion은 403이며, client가 임의로 넣은 `Remote-*`/edge-secret header는 proxy가 덮어쓰므로 SSO cookie 없이 origin data에 도달해서는 안 된다.

제한 배포기는 web/API infrastructure 복구를 위해 세 번의 target preflight에서 association만 명시적으로 skip한다. 따라서 배포 성공 자체는 mobile release 승인이 아니다. mobile release 전에는 실제 iOS Team ID와 Android signing certificate fingerprint로 두 association JSON을 공개한 뒤, promoted target container에서 `--skip-association` 없이 별도 preflight를 통과해야 한다.

migration phase가 시작된 뒤 server health가 실패하면 이전 server image만 자동 복귀시키지 않는다. schema 호환 forward-fix가 원칙이며, DB restore는 별도 staging에서 검증한 backup과 명시적 outage·data-loss 검토가 있을 때만 수행한다. web 실패는 server를 유지한 채 web image만 이전 버전으로 복귀할 수 있다. 향후 signed mobile release나 S3/local-auth provider 전환을 승인할 때는 서버 장애를 이유로 그 선택 범위의 association·provider 검증을 생략하지 않는다.

Validate의 JavaScript job은 `@playwright/test`와 같은 버전의 digest 고정 Microsoft Playwright 이미지에서 실행하며, runner마다 `playwright install --with-deps`를 다시 수행하지 않는다. server·protocol job은 runtime image와 같은 Python patch를 먼저 설치하고 그 patch를 지원하는 동일한 uv 버전으로 lockfile을 동기화한다. 저장소 루트의 `.env.example`·`docker-compose.prod.yml`을 읽는 `repository_contract` 테스트는 전체 checkout을 가진 server job에서 반드시 실행한다. PostgreSQL migration gate는 fresh DB뿐 아니라 별도 임시 DB에 재현한 Alembic 이전 운영 schema의 row 보존 upgrade도 실행한다. `apps/server`만 컨텍스트로 받는 ARM64 서버 이미지의 test target은 이 두 저장소 계약만 제외하고 나머지 서버 suite를 다시 실행한다. Android·iOS job은 각 runner의 clean checkout에서 `pnpm build:workspace-libs`를 선행한 뒤 Capacitor sync와 native compile을 수행한다. Android job은 Gradle/Capacitor의 source level과 일치하는 Temurin JDK 21 및 고정 Android platform·NDK·CMake를 사용한다. main Validate가 실패하면 후속 `Build and deploy to RPi5` 실행이 `skipped`되는 것이 정상이며, 이 경우 운영 반영으로 보고하지 않는다.

배포 완료 판정에는 다음 세 증거가 모두 필요하다.

1. main의 `Validate`가 정확한 대상 SHA로 성공한다.
2. 같은 SHA의 `Build and deploy to RPi5`에서 publish와 restricted deployment job이 모두 성공한다.
3. 공개 health와 HTML/asset 응답이 새 배포 이후 값으로 바뀌고, 핵심 경로 smoke가 통과한다.

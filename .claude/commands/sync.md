---
description: Spotify 동기화를 호출하고 결과를 요약한다.
---

다음을 순서대로 수행해주세요:

1. dev 서버가 실행 중인지 확인 (`http://localhost:3000`). 안 떠 있으면 사용자에게 `pnpm dev` 실행을 요청.
2. 사용자가 로그인되어 있다고 가정. `curl -X POST http://localhost:3000/api/sync -b "$HOME/.spotify-cookie"` 등의 방법은 쿠키 때문에 어려우니, **사용자에게 브라우저에서 `/settings` → "지금 동기화"를 누르도록 안내**한다.
3. 동기화 끝나면 사용자가 응답 요약(`liked 2300 · top 150 …`)을 붙여넣게 한다.
4. 결과에 `partial`/`failed` 단계 있으면 그 단계의 로그를 검토하고 원인을 진단한다.

참조: [docs/sync.md](../../docs/sync.md), [docs/auth-flow.md](../../docs/auth-flow.md).

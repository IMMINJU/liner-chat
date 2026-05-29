---
description: 로컬 DB 상태(테이블 카운트 + 마지막 동기화)를 빠르게 보여준다.
---

다음 SQL을 Drizzle Studio 또는 `psql`로 실행:

```sql
-- 테이블 카운트
SELECT 'users' AS t, count(*) FROM users
UNION ALL SELECT 'artists', count(*) FROM artists
UNION ALL SELECT 'tracks', count(*) FROM tracks
UNION ALL SELECT 'audio_features', count(*) FROM audio_features
UNION ALL SELECT 'liked_tracks', count(*) FROM liked_tracks
UNION ALL SELECT 'top_tracks', count(*) FROM top_tracks
UNION ALL SELECT 'plays', count(*) FROM plays
UNION ALL SELECT 'genre_signals', count(*) FROM genre_signals
UNION ALL SELECT 'curations', count(*) FROM curations
UNION ALL SELECT 'curation_tracks', count(*) FROM curation_tracks
UNION ALL SELECT 'curation_playlists', count(*) FROM curation_playlists
UNION ALL SELECT 'auth_tokens', count(*) FROM auth_tokens;

-- 마지막 동기화 (가장 최근 top_tracks snapshot)
SELECT user_id, max(snapshot_at) AS last_sync FROM top_tracks GROUP BY user_id;

-- 최근 큐레이션 5개
SELECT id, user_id, seed_track_id, parent_curation_id, created_at
FROM curations ORDER BY created_at DESC LIMIT 5;
```

`pnpm db:studio`로 열거나 Neon 콘솔에서.

import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  date,
  real,
  jsonb,
  primaryKey,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
// type-only: lib/pipelineStats.ts는 순수 타입 파일이라 drizzle-kit 컴파일에
// 런타임 의존을 끌고 오지 않는다 (상대경로 — drizzle-kit은 @/ alias를 모름).
import type { PipelineStatsV1 } from '../lib/pipelineStats'

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const artists = pgTable('artists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  spotifyGenres: text('spotify_genres').array().notNull().default([]),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
})

export const tracks = pgTable('tracks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  artistId: text('artist_id')
    .notNull()
    .references(() => artists.id),
  album: text('album'),
  albumReleaseDate: date('album_release_date'),
  albumCoverUrl: text('album_cover_url'),
  durationMs: integer('duration_ms'),
  spotifyUrl: text('spotify_url'),
  previewUrl: text('preview_url'),
})

export const audioFeatures = pgTable('audio_features', {
  trackId: text('track_id')
    .primaryKey()
    .references(() => tracks.id),
  energy: real('energy'),
  valence: real('valence'),
  tempo: real('tempo'),
  acousticness: real('acousticness'),
  danceability: real('danceability'),
  instrumentalness: real('instrumentalness'),
  speechiness: real('speechiness'),
  liveness: real('liveness'),
  // Tonal context for LLM seed analysis (not used as a filter).
  key: integer('key'),                  // 0..11 (Spotify pitch class), -1 → null
  mode: integer('mode'),                // 1=major, 0=minor
  timeSignature: integer('time_signature'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const likedTracks = pgTable(
  'liked_tracks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id),
    likedAt: timestamp('liked_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.trackId] }),
  })
)

export const topTracks = pgTable(
  'top_tracks',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id),
    timeRange: text('time_range').notNull(), // 'short_term' | 'medium_term' | 'long_term'
    rank: integer('rank').notNull(),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.userId, t.trackId, t.timeRange, t.snapshotAt],
    }),
  })
)

export const plays = pgTable(
  'plays',
  {
    id: serial('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    uniqPlay: uniqueIndex('plays_user_track_at_uniq').on(
      t.userId,
      t.trackId,
      t.playedAt
    ),
  })
)

// Mode 1: 라이브러리 장르 점수
export const genreSignals = pgTable('genre_signals', {
  trackId: text('track_id')
    .primaryKey()
    .references(() => tracks.id),
  scores: jsonb('scores').notNull(), // {"jazz":0.8,"rock":0.1,...}
  rawTags: jsonb('raw_tags'),
  computedAt: timestamp('computed_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

// Mode 2: 친족 큐레이션 세션
export const curations = pgTable('curations', {
  id: serial('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  query: text('query'),
  seedTrackId: text('seed_track_id')
    .notNull()
    .references(() => tracks.id),
  parentCurationId: integer('parent_curation_id').references(
    (): AnyPgColumn => curations.id
  ),
  lineageNotes: text('lineage_notes'),
  // 파이프라인 관측 데이터 (verify 사유별/카테고리별 집계 + leap 감사 + 타이밍).
  // nullable: 과거 행과 저장 실패 경로 허용. API 응답 계약과 무관 — DB 전용.
  pipelineStats: jsonb('pipeline_stats').$type<PipelineStatsV1>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const curationTracks = pgTable(
  'curation_tracks',
  {
    curationId: integer('curation_id')
      .notNull()
      .references(() => curations.id),
    trackId: text('track_id')
      .notNull()
      .references(() => tracks.id),
    category: text('category').notNull(), // 'influence'|'peer'|'descendant'|'kinship'
    sonicLink: text('sonic_link').notNull(),
    linkDimensions: text('link_dimensions').array().notNull().default([]),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.curationId, t.trackId] }),
  })
)

export const curationPlaylists = pgTable('curation_playlists', {
  curationId: integer('curation_id')
    .primaryKey()
    .references(() => curations.id),
  spotifyPlaylistId: text('spotify_playlist_id').notNull(),
  savedAt: timestamp('saved_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
})

export const authTokens = pgTable('auth_tokens', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scope: text('scope'),
})

export type User = typeof users.$inferSelect
export type Artist = typeof artists.$inferSelect
export type Track = typeof tracks.$inferSelect
export type AudioFeature = typeof audioFeatures.$inferSelect
export type Curation = typeof curations.$inferSelect
export type CurationTrack = typeof curationTracks.$inferSelect
export type AuthToken = typeof authTokens.$inferSelect

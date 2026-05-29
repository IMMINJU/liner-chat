CREATE TABLE "artists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"spotify_genres" text[] DEFAULT '{}' NOT NULL,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audio_features" (
	"track_id" text PRIMARY KEY NOT NULL,
	"energy" real,
	"valence" real,
	"tempo" real,
	"acousticness" real,
	"danceability" real,
	"instrumentalness" real,
	"speechiness" real,
	"liveness" real,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"user_id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "curation_playlists" (
	"curation_id" integer PRIMARY KEY NOT NULL,
	"spotify_playlist_id" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curation_tracks" (
	"curation_id" integer NOT NULL,
	"track_id" text NOT NULL,
	"category" text NOT NULL,
	"sonic_link" text NOT NULL,
	"link_dimensions" text[] DEFAULT '{}' NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "curation_tracks_curation_id_track_id_pk" PRIMARY KEY("curation_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "curations" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"query" text,
	"seed_track_id" text NOT NULL,
	"parent_curation_id" integer,
	"lineage_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "genre_signals" (
	"track_id" text PRIMARY KEY NOT NULL,
	"scores" jsonb NOT NULL,
	"raw_tags" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liked_tracks" (
	"user_id" text NOT NULL,
	"track_id" text NOT NULL,
	"liked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "liked_tracks_user_id_track_id_pk" PRIMARY KEY("user_id","track_id")
);
--> statement-breakpoint
CREATE TABLE "plays" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"track_id" text NOT NULL,
	"played_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "top_tracks" (
	"user_id" text NOT NULL,
	"track_id" text NOT NULL,
	"time_range" text NOT NULL,
	"rank" integer NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	CONSTRAINT "top_tracks_user_id_track_id_time_range_snapshot_at_pk" PRIMARY KEY("user_id","track_id","time_range","snapshot_at")
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"artist_id" text NOT NULL,
	"album" text,
	"album_release_date" date,
	"duration_ms" integer,
	"spotify_url" text,
	"preview_url" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audio_features" ADD CONSTRAINT "audio_features_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_playlists" ADD CONSTRAINT "curation_playlists_curation_id_curations_id_fk" FOREIGN KEY ("curation_id") REFERENCES "public"."curations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_tracks" ADD CONSTRAINT "curation_tracks_curation_id_curations_id_fk" FOREIGN KEY ("curation_id") REFERENCES "public"."curations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_tracks" ADD CONSTRAINT "curation_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curations" ADD CONSTRAINT "curations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curations" ADD CONSTRAINT "curations_seed_track_id_tracks_id_fk" FOREIGN KEY ("seed_track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curations" ADD CONSTRAINT "curations_parent_curation_id_curations_id_fk" FOREIGN KEY ("parent_curation_id") REFERENCES "public"."curations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "genre_signals" ADD CONSTRAINT "genre_signals_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liked_tracks" ADD CONSTRAINT "liked_tracks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liked_tracks" ADD CONSTRAINT "liked_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays" ADD CONSTRAINT "plays_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_tracks" ADD CONSTRAINT "top_tracks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "top_tracks" ADD CONSTRAINT "top_tracks_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "public"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plays_user_track_at_uniq" ON "plays" USING btree ("user_id","track_id","played_at");
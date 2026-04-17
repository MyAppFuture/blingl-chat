CREATE TYPE "public"."message_type" AS ENUM('text', 'image', 'gif', 'system');--> statement-breakpoint
CREATE TABLE "blocked_users" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_users_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "blocked_users_not_self_check" CHECK ("blocked_users"."blocker_id" <> "blocked_users"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a_id" uuid NOT NULL,
	"user_b_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"next_sequence_number" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "conversations_user_order_check" CHECK ("conversations"."user_a_id" < "conversations"."user_b_id")
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "message_reads" (
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_reads_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sequence_number" bigint NOT NULL,
	"client_nonce" text NOT NULL,
	"content" text NOT NULL,
	"message_type" "message_type" DEFAULT 'text' NOT NULL,
	"reply_to_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reads" ADD CONSTRAINT "message_reads_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_users_blocked_idx" ON "blocked_users" USING btree ("blocked_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_user_pair_unique" ON "conversations" USING btree ("user_a_id","user_b_id");--> statement-breakpoint
CREATE INDEX "conversations_user_a_last_message_idx" ON "conversations" USING btree ("user_a_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversations_user_b_last_message_idx" ON "conversations" USING btree ("user_b_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "message_reads_user_idx" ON "message_reads" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_sequence_unique" ON "messages" USING btree ("conversation_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_nonce_unique" ON "messages" USING btree ("conversation_id","client_nonce");--> statement-breakpoint
CREATE INDEX "messages_conversation_sequence_desc_idx" ON "messages" USING btree ("conversation_id","sequence_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_conversation_created_desc_idx" ON "messages" USING btree ("conversation_id","created_at" DESC NULLS LAST);
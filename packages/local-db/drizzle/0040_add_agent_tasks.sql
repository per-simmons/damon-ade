CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`workspace_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`dispatched_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_tasks_status_idx` ON `agent_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `agent_tasks_workspace_id_idx` ON `agent_tasks` (`workspace_id`);
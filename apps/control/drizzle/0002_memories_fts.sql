CREATE VIRTUAL TABLE `memories_fts` USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);
--> statement-breakpoint
CREATE TRIGGER `memories_fts_insert` AFTER INSERT ON `memories` BEGIN
  INSERT INTO `memories_fts`(`rowid`, `content`) VALUES (new.`rowid`, new.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_delete` AFTER DELETE ON `memories` BEGIN
  INSERT INTO `memories_fts`(`memories_fts`, `rowid`, `content`) VALUES ('delete', old.`rowid`, old.`content`);
END;
--> statement-breakpoint
CREATE TRIGGER `memories_fts_update` AFTER UPDATE ON `memories` BEGIN
  INSERT INTO `memories_fts`(`memories_fts`, `rowid`, `content`) VALUES ('delete', old.`rowid`, old.`content`);
  INSERT INTO `memories_fts`(`rowid`, `content`) VALUES (new.`rowid`, new.`content`);
END;
--> statement-breakpoint
INSERT INTO `memories_fts`(`rowid`, `content`) SELECT `rowid`, `content` FROM `memories`;

INSERT INTO ai_control (id, blocked) VALUES (1, 0);

CREATE TRIGGER notes_capacity BEFORE INSERT ON notes BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM notes WHERE owner = NEW.owner) >= 100
    OR (SELECT COUNT(*) FROM notes) >= 1000 THEN RAISE(ABORT, 'NOTE_LIMIT') END;
END;

CREATE TRIGGER ai_admission BEFORE INSERT ON ai_requests BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ai_control WHERE id = 1 AND blocked = 0)
    THEN RAISE(ABORT, 'AI_BLOCKED') END;
  SELECT CASE WHEN NEW.units != 1000 OR NEW.budget < 1000 OR NEW.budget > 5000
    OR NEW.session_limit < 1 OR NEW.session_limit > 10 OR NEW.active != 1
    THEN RAISE(ABORT, 'AI_BLOCKED') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM ai_requests WHERE active = 1) >= 1
    THEN RAISE(ABORT, 'AI_BUSY') END;
  SELECT CASE WHEN (SELECT COALESCE(SUM(units), 0) FROM ai_requests WHERE day = NEW.day) + NEW.units > NEW.budget
    OR (SELECT COUNT(*) FROM ai_requests WHERE day = NEW.day AND owner = NEW.owner) >= NEW.session_limit
    OR (SELECT COUNT(*) FROM ai_requests WHERE day = NEW.day AND ip = NEW.ip) >= 3
    THEN RAISE(ABORT, 'AI_LIMIT') END;
END;

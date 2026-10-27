-- 0091 — two rules span a share and its connection, so triggers hold them from both sides, each
-- refusal a `check_violation` naming the rule as its constraint: only a member's connection is
-- shared (`ics_end_user_not_shared`), and a space-scoped connection is shared into its own space only
-- (`ics_space_shares_own`). `ics_share_invariants` judges a share written against its connection;
-- `ics_connection_keeps_shares` judges a connection losing its member owner or taking a space against
-- its shares, and does not fire on any other update. A share write locks its connection FOR SHARE,
-- which a connection update waits on, so of a share and a narrowing racing under READ COMMITTED the
-- second to lock sees the first committed and is refused. A share of a missing connection is the
-- foreign key's refusal.
CREATE FUNCTION ics_share_invariants_fn() RETURNS trigger AS $fn$
DECLARE
	conn record;
	broken text;
BEGIN
	SELECT user_id, space_id INTO conn FROM integration_connections WHERE id = NEW.connection_id FOR SHARE;
	IF NOT FOUND THEN
		RETURN NEW;
	END IF;
	IF conn.user_id IS NULL THEN
		broken := 'ics_end_user_not_shared';
	ELSIF conn.space_id IS NOT NULL AND conn.space_id <> NEW.space_id THEN
		broken := 'ics_space_shares_own';
	ELSE
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'new row for relation "integration_connection_shares" violates check constraint "%"', broken
		USING ERRCODE = 'check_violation', TABLE = 'integration_connection_shares', CONSTRAINT = broken;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ics_share_invariants
	BEFORE INSERT OR UPDATE ON integration_connection_shares
	FOR EACH ROW
	EXECUTE FUNCTION ics_share_invariants_fn();
--> statement-breakpoint
CREATE FUNCTION ics_connection_keeps_shares_fn() RETURNS trigger AS $fn$
DECLARE
	broken text;
BEGIN
	IF NEW.user_id IS NULL AND EXISTS (
		SELECT 1 FROM integration_connection_shares WHERE connection_id = NEW.id
	) THEN
		broken := 'ics_end_user_not_shared';
	ELSIF NEW.space_id IS NOT NULL AND EXISTS (
		SELECT 1 FROM integration_connection_shares WHERE connection_id = NEW.id AND space_id <> NEW.space_id
	) THEN
		broken := 'ics_space_shares_own';
	ELSE
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'new row for relation "integration_connections" violates check constraint "%"', broken
		USING ERRCODE = 'check_violation', TABLE = 'integration_connections', CONSTRAINT = broken;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ics_connection_keeps_shares
	BEFORE UPDATE OF space_id, user_id ON integration_connections
	FOR EACH ROW
	WHEN (
		(NEW.user_id IS NULL AND OLD.user_id IS NOT NULL)
		OR (NEW.space_id IS NOT NULL AND NEW.space_id IS DISTINCT FROM OLD.space_id)
	)
	EXECUTE FUNCTION ics_connection_keeps_shares_fn();
